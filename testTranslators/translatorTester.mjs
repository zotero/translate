/*
    ***** BEGIN LICENSE BLOCK *****
    
    Copyright © 2009 Center for History and New Media
                     George Mason University, Fairfax, Virginia, USA
                     http://zotero.org
    
    This file is part of Zotero.
    
    Zotero is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.
    
    Zotero is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Affero General Public License for more details.
    
    You should have received a copy of the GNU Affero General Public License
    along with Zotero.  If not, see <http://www.gnu.org/licenses/>.
    
    ***** END LICENSE BLOCK *****
*/

import { Test } from './test.mjs';

const { Zotero } = typeof globalThis.Zotero === 'undefined'
	? ChromeUtils.importESModule('chrome://zotero/content/zotero.mjs')
	: globalThis;
const { setTimeout } = typeof globalThis.setTimeout === 'undefined'
	? ChromeUtils.importESModule('resource://gre/modules/Timer.sys.mjs')
	: globalThis;

export const DEFAULT_DEFER_DELAY = 5; // Default delay for deferred tests (in seconds)
export const TEST_RUN_TIMEOUT = 15000;

export class TranslatorTester {

	/**
	 * @param {Zotero.Translator} translator
	 * @param {AbstractWebTranslationEnvironment} [webTranslationEnvironment]
	 * @param {Zotero.Translators} [translatorProvider]
	 * @param {Zotero.CookieSandbox} [cookieSandbox]
	 * @param {(message: any) => void} [debug]
	 */
	constructor(translator, {
		webTranslationEnvironment,
		translatorProvider,
		cookieSandbox,
		debug
	} = {}) {
		this._webTranslationEnvironment = webTranslationEnvironment ?? new HTTPWebTranslationEnvironment();
		this._translator = translator;
		this._translatorProvider = translatorProvider ?? Zotero.Translators;
		if (!cookieSandbox && typeof process === 'object' && process + '' === '[object process]') {
			cookieSandbox = require('request').jar();
		}
		this._cookieSandbox = cookieSandbox;
		this._debug = debug ?? (message => Zotero.debug(message));
	}

	get translator() {
		return this._translator;
	}
	
	get translatorProvider() {
		return this._translatorProvider;
	}
	
	get cookieSandbox() {
		return this._cookieSandbox;
	}
	
	/**
	 * @returns {Promise<Test[]>}
	 */
	async getTestsInTranslator() {
		let code = await this._translatorProvider.getCodeForTranslator(this._translator);
		let testStart = code.indexOf("/** BEGIN TEST CASES **/");
		let testEnd = code.indexOf("/** END TEST CASES **/");
		if (testStart === -1 || testEnd === -1) {
			return [];
		}
		
		let testsJSON = code.substring(testStart + 24, testEnd)
			.replace(/^[\s\r\n]*var testCases = /, '')
			.replace(/;[\s\r\n]*$/, '');
		let tests;
		try {
			tests = JSON.parse(testsJSON);
		}
		catch {
			return [];
		}
		
		if (!Array.isArray(tests)) {
			Zotero.debug('Discarding non-array testCases object');
			return [];
		}
		
		return tests.map(test => new Test(test));
	}

	/**
	 * Run a test in the context of this translator.
	 *
	 * @param {Test} test
	 * @returns {Promise<{
	 *     status: 'success' | 'failure';
	 *     reason?: string;
	 *     updatedTest?: Test;
	 * }>}
	 */
	async run(test) {
		let abortController = new AbortController();
		setTimeout(() => {
			abortController.abort(new Error(`Test timed out after ${TEST_RUN_TIMEOUT / 1000} seconds`));
		}, TEST_RUN_TIMEOUT);

		let result;
		switch (test.type) {
			case 'web':
				try {
					result = await this._translateWeb(test, { signal: abortController.signal });
				}
				catch (e) {
					return { status: 'failure', reason: String(e) };
				}
				break;
			case 'import':
			case 'search':
				try {
					result = await this._translateImportOrSearch(test, { signal: abortController.signal });
				}
				catch (e) {
					return { status: 'failure', reason: String(e) };
				}
				break;
			case 'export':
				throw new Error('Export tests are not yet supported');
			default:
				throw new Error(`Unknown test type: ${test.type}`);
		}
		
		let { detectedItemType, items, reason } = result;
		if (!items) {
			// Expected-fail test
			if (!detectedItemType && test.detectedItemType === false) {
				return { status: 'success' };
			}
			// Regular failure
			else {
				return { status: 'failure', reason };
			}
		}
		
		let updatedTest = new Test(test);
		updatedTest.detectedItemType = detectedItemType;
		updatedTest.items = items;

		if (test.detectedItemType !== detectedItemType) {
			return {
				status: 'failure',
				reason: 'Detection returned wrong item type',
				updatedTest,
			};
		}

		if (test.items === 'multiple' || items === 'multiple') {
			if (test.items !== items) {
				return {
					status: 'failure',
					reason: `Expected ${test.items === 'multiple' ? 'multiple' : 'single item'}, got ${
						items === 'multiple' ? 'multiple' : 'single item'}`,
					updatedTest,
				};
			}
		}
		
		if (!test.equals(updatedTest)) {
			return {
				status: 'failure',
				reason: 'Data mismatch',
				updatedTest,
			};
		}
		
		return {
			status: 'success',
			// Include the updated test in case it has non-failing differences like
			// schema changes
			updatedTest,
		};
	}
	
	async _translateWeb(test, { signal }) {
		let page = await this._webTranslationEnvironment.fetchPage(test.url, { tester: this });

		let numSelectItemsCalls = 0;
		let result;
		try {
			let assumePageIsLoaded = await this._webTranslationEnvironment.waitForLoad(page, { tester: this });
			if (!assumePageIsLoaded && test.defer) {
				let delay = typeof test.defer === 'number'
					? test.defer
					: DEFAULT_DEFER_DELAY;
				this._debug(`Waiting ${delay} ${Zotero.Utilities.pluralize(delay, 'second')} for page content to settle`);
				await Zotero.Promise.delay(delay * 1000);
			}

			result = await this._webTranslationEnvironment.runTranslation(page, {
				tester: this,
				signal,
				handlers: {
					debug: (_, message) => this._debug(message),
					error: (_, error) => this._debug(error),
					select: async (_, items, callback) => {
						numSelectItemsCalls++;

						// Translate up to three results
						items = Object.fromEntries(Object.entries(items).slice(0, 3));

						// It's hard to deal with a callback across messaging-only
						// boundaries. This handler should technically (unfortunately)
						// be passed a callback, but we'll return a promise too.
						if (callback && typeof callback === 'function') {
							// Invoke callback asynchronously, as a browser would
							setTimeout(() => callback(items));
						}
						return items;
					},
				},
			});
		}
		finally {
			await this._webTranslationEnvironment.destroy(page);
		}
		
		let { detectedItemType, items, reason } = result;
		
		// Failures:
		if (!items && reason) {
			return { detectedItemType, items, reason };
		}
		if (!items?.length) {
			return { detectedItemType, items: null, reason: 'Translator did not return any items' };
		}
		if (numSelectItemsCalls > 1) {
			return { detectedItemType, items: null, reason: 'Translator called selectItems multiple times' };
		}
		
		// Success after selectItems():
		if (numSelectItemsCalls) {
			return { detectedItemType, items: 'multiple' };
		}
		
		// Standard success:
		return { detectedItemType, items };
	}
	
	async _translateImportOrSearch(test, { signal }) {
		let { type } = test;
		let translate = Zotero.Translate.newInstance(type);
		if (type === 'import') {
			translate.setString(test.input);
		}
		else {
			translate.setSearch(test.input);
			translate.setCookieSandbox(this._cookieSandbox);
		}
		translate.setTranslatorProvider(this._translatorProvider);
		translate.setTranslator(this._translator);
		translate.setHandler('debug', (_, message) => this._debug(message));
		translate.setHandler('error', (_, error) => this._debug(error));

		signal.addEventListener('abort', () => {
			translate.complete(false, new Error(signal.reason));
		});

		// "internal hack to call detect on this translator"
		// We have to use this horrible routine because non-web Translates
		// don't support checkSetTranslators (why not?)
		translate._potentialTranslators = [this._translator];
		translate._foundTranslators = [];
		translate._currentState = 'detect';
		let detectedItemType = await translate._detect();
		
		if (!detectedItemType) {
			return { items: null, reason: 'Detection failed' };
		}

		return { detectedItemType, items: await translate.translate({ libraryID: false }) };
	}
}

/**
 * @abstract
 */
export class AbstractWebTranslationEnvironment {

	/**
	 * @abstract
	 * @param {string} url
	 * @param {TranslatorTester} tester
	 * @returns {Promise<unknown>}
	 */
	async fetchPage(url, { tester }) {
		throw new Error('Unimplemented');
	}

	/**
	 * @abstract
	 * @param {unknown} page
	 * @param {TranslatorTester} tester
	 * @returns {Promise<boolean>} Return false if still not sure that the page is fully loaded
	 */
	async waitForLoad(page, { tester }) {
		throw new Error('Unimplemented');
	}

	/**
	 * @abstract
	 * @param {unknown} page The object returned from fetchPage() earlier
	 * @param {TranslatorTester} tester
	 * @param {Record<string, Function>} handlers
	 * @param {AbortSignal} signal
	 * @returns {Promise<{
	 *     detectedItemType?: string;
	 *     items?: Zotero.Item[];
	 *     reason?: string;
	 * }>}
	 */
	async runTranslation(page, { tester, handlers, signal }) {
		throw new Error('Unimplemented');
	}

	/**
	 * @param {unknown} page The object returned from fetchPage() earlier
	 * @returns {Promise<void> | void}
	 */
	destroy(page) {
		// Default no-op implementation
	}
}

export class HTTPWebTranslationEnvironment extends AbstractWebTranslationEnvironment {

	/**
	 * @param {string} url
	 * @param {TranslatorTester} tester
	 * @returns {Promise<Document>}
	 */
	async fetchPage(url, { tester }) {
		return new Promise(resolve => Zotero.HTTP.processDocuments(
			url,
			doc => resolve(doc),
			{ cookieSandbox: tester.cookieSandbox }
		));
	}

	/**
	 * @param {Document} doc
	 * @param {TranslatorTester} tester
	 * @returns {Promise<true>} Always true, no more waiting necessary - our document is static
	 */
	async waitForLoad(doc, { tester }) {
		return true;
	}

	/**
	 * @param {Document} doc
	 * @param {TranslatorTester} tester
	 * @param {Record<string, Function>} handlers
	 * @param {AbortSignal} signal
	 * @returns {Promise<{
	 *     detectedItemType?: string;
	 *     items?: Zotero.Item[];
	 *     reason?: string;
	 * }>}
	 */
	async runTranslation(doc, { tester, handlers, signal }) {
		let translate = new Zotero.Translate.Web();
		translate.setDocument(doc);
		translate.setTranslatorProvider(tester.translatorProvider);
		translate.setCookieSandbox(tester.cookieSandbox);
		translate.setTranslator(tester.translator);
		for (let [type, fn] of Object.entries(handlers)) {
			translate.setHandler(type, fn);
		}

		signal.addEventListener('abort', () => {
			translate.complete(false, new Error(signal.reason));
		});

		let detectedTranslators = await translate.getTranslators(
			/* getAllTranslators */ false,
			/* checkSetTranslator */ true
		);
		if (!detectedTranslators.length) {
			return { items: null, reason: 'Detection failed' };
		}

		let detectedItemType = detectedTranslators[0].itemType;
		let items = await translate.translate();
		return { detectedItemType, items };
	}
}

