import { diff } from './diff.mjs';

const { Zotero } = typeof globalThis.Zotero === 'undefined'
	? ChromeUtils.importESModule('chrome://zotero/content/zotero.mjs')
	: globalThis;

export const TEST_TYPES = ['web', 'import', 'export', 'search'];

export class Test {
	constructor(testInit) {
		if (testInit instanceof this.constructor) {
			testInit = testInit.toJSON();
		}
		this.type = testInit.type;
		this.defer = testInit.defer ?? false;
		this.input = testInit.input ?? testInit.url;
		this.items = testInit.items;
		this.detectedItemType = testInit.detectedItemType ?? this._inferItemType();
	}

	get type() {
		return this._type;
	}

	set type(type) {
		if (!TEST_TYPES.includes(type)) {
			throw new Error(`Invalid test type: ${type}`);
		}
		this._type = type;
	}

	get defer() {
		return this._defer;
	}

	set defer(defer) {
		if (defer) {
			if (defer !== true && typeof defer !== 'number') {
				throw new Error(`Invalid defer: ${defer}`);
			}
		}
		else {
			defer = undefined;
		}
		this._defer = defer;
	}

	get input() {
		return this._input;
	}

	set input(input) {
		let expectedType = this._type === 'web' || this._type === 'import'
			? 'string'
			: 'object';
		if (typeof input !== expectedType) {
			throw new Error(`${this._type} test input must be a string`);
		}
		this._input = input;
	}

	get url() {
		if (this._type !== 'web') {
			throw new Error(`${this._type} test has no url`);
		}
		return this._input;
	}

	set url(url) {
		if (this._type !== 'web') {
			throw new Error(`${this._type} test has no url`);
		}
		this._input = url;
	}

	get detectedItemType() {
		return this._detectedItemType;
	}

	set detectedItemType(detectedItemType) {
		if (detectedItemType !== undefined
			&& typeof detectedItemType !== 'string' && typeof detectedItemType !== 'boolean') {
			throw new Error('detectedItemType must be a string or boolean');
		}
		this._detectedItemType = detectedItemType;
	}

	get items() {
		return this._items;
	}

	set items(items) {
		if (!Array.isArray(items) && items !== 'multiple') {
			throw new Error('items must be an array or "multiple"');
		}
		this._items = Array.isArray(items)
			? items.map(item => sanitizeItem(item))
			: items;
	}

	/**
	 * @param {Test} test
	 */
	equals(test) {
		return deepEqual(this.toJSON(), test.toJSON());
	}

	/**
	 * @param {Test} test
	 * @returns {string}
	 */
	diffWith(test) {
		// JSON.parse(JSON.stringify()) runs toJSON() and removes
		// undefined fields
		let cleaned1 = JSON.parse(JSON.stringify(this));
		let cleaned2 = JSON.parse(JSON.stringify(test));
		return diff(cleaned1, cleaned2);
	}

	toJSON() {
		return {
			type: this._type,
			defer: this._defer,
			[this._type === 'web' ? 'url' : 'input']: this._input,
			detectedItemType:
				this._detectedItemType && this._detectedItemType === this._inferItemType()
					? undefined
					: this._detectedItemType,
			items: this._items,
		};
	}

	_inferItemType() {
		if (this._type !== 'web') {
			return !!this._items.length;
		}
		else if (this._items === 'multiple') {
			return 'multiple';
		}
		else if (this._items.length) {
			return this._items[0].itemType;
		}
		else {
			return false;
		}
	}
}

/**
 * Removes document objects, which contain cyclic references, and other fields to be ignored from items
 * @param {any} item Item, in the format returned by Zotero.Item.serialize()
 */
function sanitizeItem(item) {
	// remove cyclic references
	if (item.attachments && item.attachments.length) {
		// don't actually test URI equality
		for (let attachment of item.attachments) {
			if (attachment.document) {
				delete attachment.document;
				// Mirror connector/server itemDone() behavior from translate.js
				attachment.mimeType = 'text/html';
			}

			if (attachment.url) {
				delete attachment.url;
			}

			if (attachment.complete) {
				delete attachment.complete;
			}
		}
	}

	// try to convert to JSON and back to get rid of undesirable undeletable elements; this may fail
	try {
		item = JSON.parse(JSON.stringify(item));
	}
	catch {}

	// Remove fields that don't exist or aren't valid for this item type, and normalize base fields
	// to fields specific to this item
	let typeID = Zotero.ItemTypes.getID(item.itemType);
	const skipFields = new Set([
		'note',
		'notes',
		'itemID',
		'attachments',
		'tags',
		'seeAlso',
		'itemType',
		'creators',
		'complete',
	]);
	for (let field in item) {
		if (skipFields.has(field)) {
			continue;
		}

		let fieldID = Zotero.ItemFields.getID(field);
		if (!fieldID || !item[field]) {
			delete item[field];
			continue;
		}

		// If this item type has a type-specific subfield for this field,
		// move the value to that field
		let subfieldID = Zotero.ItemFields.getFieldIDFromTypeAndBase(typeID, fieldID);
		if (subfieldID && subfieldID !== fieldID) {
			item[Zotero.ItemFields.getName(subfieldID)] = item[field];
			delete item[field];
			continue;
		}

		if (!Zotero.ItemFields.isValidForType(fieldID, typeID)) {
			delete item[field];
		}
	}

	// remove fields to be ignored
	delete item.accessDate;

	// Sort tags
	if (item.tags && Array.isArray(item.tags)) {
		// Normalize tags -- necessary until tests are updated for 5.0
		item.tags = Zotero.Translate.Base.prototype._cleanTags(item.tags);
		item.tags.sort((a, b) => {
			if (a.tag < b.tag) return -1;
			if (b.tag < a.tag) return 1;
			return 0;
		});
	}

	return item;
}

function deepEqual(a, b) {
	if (
		(typeof a === 'object' && a !== null || typeof a === 'function')
		&& (typeof a === 'object' && b !== null || typeof b === 'function')
	) {
		if (Array.isArray(a) !== Array.isArray(b)) {
			return false;
		}
		for (let key in a) {
			if (!a.hasOwnProperty(key)) continue;
			if (!b.hasOwnProperty(key)) return false;
			if (!deepEqual(a[key], b[key])) return false;
		}
		for (let key in b) {
			if (!b.hasOwnProperty(key)) continue;
			if (!a.hasOwnProperty(key)) return false;
		}
		return true;
	}
	else if (typeof a === 'string' && typeof b === 'string') {
		// Ignore whitespace mismatches on strings
		// (TODO: Do we really want that?)
		return a === b || Zotero.Utilities.trimInternal(a) === Zotero.Utilities.trimInternal(b);
	}
	return a === b;
}

