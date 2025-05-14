/**
 * Generate a diff between tests or items
 */
export function diff(a, b) {
	function show(a, action, prefix, indent) {
		if ((typeof a === 'object' && a !== null) || typeof a === 'function') {
			var isArray = Object.prototype.toString.apply(a) === '[object Array]',
				startBrace = (isArray ? '[' : '{'),
				endBrace = (isArray ? ']' : '}'),
				changes = '',
				haveKeys = false;

			for (var key in a) {
				if (!a.hasOwnProperty(key)) continue;

				haveKeys = true;
				changes += show(a[key], action,
					isArray ? '' : JSON.stringify(key) + ': ', indent + '  ');
			}

			if (haveKeys) {
				return action + ' ' + indent + prefix + startBrace + '\n'
					+ changes + action + ' ' + indent + endBrace + '\n';
			}
			return action + ' ' + indent + prefix + startBrace + endBrace + '\n';
		}

		return action + ' ' + indent + prefix + JSON.stringify(a) + '\n';
	}

	function compare(a, b, prefix, indent) {
		if (!prefix) prefix = '';
		if (!indent) indent = '';

		if (((typeof a === 'object' && a !== null) || typeof a === 'function')
			&& ((typeof b === 'object' && b !== null) || typeof b === 'function')) {
			let aIsArray = Array.isArray(a),
				bIsArray = Array.isArray(b);
			if (aIsArray === bIsArray) {
				let startBrace = (aIsArray ? '[' : '{'),
					endBrace = (aIsArray ? ']' : '}'),
					changes = '',
					haveKeys = false;

				for (let key in a) {
					if (!a.hasOwnProperty(key)) continue;

					haveKeys = true;
					let keyPrefix = aIsArray ? '' : JSON.stringify(key) + ': ';
					if (b.hasOwnProperty(key)) {
						changes += compare(a[key], b[key], keyPrefix, indent + '  ');
					}
					else {
						changes += show(a[key], '-', keyPrefix, indent + '  ');
					}
				}
				for (var key in b) {
					if (!b.hasOwnProperty(key)) continue;

					haveKeys = true;
					if (!a.hasOwnProperty(key)) {
						var keyPrefix = aIsArray ? '' : JSON.stringify(key) + ': ';
						changes += show(b[key], '+', keyPrefix, indent + '  ');
					}
				}

				if (haveKeys) {
					return '  ' + indent + prefix + startBrace + '\n'
						+ changes + '  ' + indent + (aIsArray ? ']' : '}') + '\n';
				}
				return '  ' + indent + prefix + startBrace + endBrace + '\n';
			}
		}

		if (a === b) {
			return show(a, ' ', prefix, indent);
		}
		return show(a, '-', prefix, indent) + show(b, '+', prefix, indent);
	}

	// Remove last newline
	return compare(a, b).trimEnd();
}
