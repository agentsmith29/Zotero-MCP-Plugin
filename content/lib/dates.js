/* global Zotero, ZoteroMCP */

// Dates written by the plugin are stored as DD/MM/YYYY (MM/YYYY or YYYY when the day or
// month is unknown). Zotero parses a date field according to the app language, so in
// en-US it would read 05/03/2020 as 3 May; the plugin therefore stores Zotero's multipart
// form "YYYY-MM-DD DD/MM/YYYY", which Zotero keeps as given: the display text is DD/MM/YYYY
// and sorting, citations and Better BibTeX all see the intended date.
ZoteroMCP.Dates = (function () {
	const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August",
		"September", "October", "November", "December"];

	const pad = n => String(n).padStart(2, "0");

	function valid(y, m, d) {
		if (y < 1 || y > 9999 || (m !== null && (m < 1 || m > 12))) {
			return false;
		}
		if (d === null) {
			return true;
		}
		const date = new Date(Date.UTC(y, m - 1, d));
		return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
	}

	/**
	 * @param {String} input
	 * @return {{year: Number, month: Number|null, day: Number|null, ambiguous: Boolean, swapped: Boolean}|null}
	 *   null when the text is not a single calendar date this parser can read reliably
	 */
	function parse(input) {
		const s = String(input || "").trim();
		if (!s) {
			return null;
		}
		let m;
		const num = x => parseInt(x, 10);
		const result = (year, month = null, day = null, extra = {}) => (
			valid(year, month, day) ? Object.assign({ year, month, day, ambiguous: false, swapped: false }, extra) : null
		);

		// Year first: 2020-03-05, 2020/3/5, 2020.03.05, ISO date-times, 2020-03
		if ((m = /^(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?(?:[T\s]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(s))) {
			return result(num(m[1]), num(m[2]), m[3] ? num(m[3]) : null);
		}
		// 20200305
		if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) {
			return result(num(m[1]), num(m[2]), num(m[3]));
		}
		// Year last: DD/MM/YYYY is the standard; MM/DD/YYYY is recognised when the second number is above 12
		if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s))) {
			const a = num(m[1]);
			const b = num(m[2]);
			const y = num(m[3]);
			if (b > 12 && a <= 12) {
				return result(y, a, b, { swapped: true });
			}
			return result(y, b, a, { ambiguous: a <= 12 && b <= 12 && a !== b });
		}
		// 08/1999
		if ((m = /^(\d{1,2})[-/.](\d{4})$/.exec(s))) {
			return result(num(m[2]), num(m[1]));
		}
		// 1999
		if (/^\d{4}$/.test(s)) {
			return result(num(s));
		}
		// Month names ("March 5, 2020", "5 Mar 2020", "Aug./1999"): Zotero's parser knows them;
		// only accept when nothing but punctuation is left over
		if (/[a-z]/i.test(s)) {
			const parsed = Zotero.Date.strToDate(s);
			const leftover = String(parsed.part === undefined || parsed.part === "undefined" ? "" : parsed.part);
			if (parsed.year && parsed.month !== undefined && !/[a-z0-9]/i.test(leftover)
					&& /[a-z]{3,}/i.test(s.replace(/\b(st|nd|rd|th)\b/gi, ""))) {
				return result(num(parsed.year), parsed.month + 1, parsed.day ? num(parsed.day) : null);
			}
		}
		return null;
	}

	function format({ year, month, day }) {
		if (day) {
			return `${pad(day)}/${pad(month)}/${year}`;
		}
		if (month) {
			return `${pad(month)}/${year}`;
		}
		return String(year);
	}

	function describe({ year, month, day }) {
		return [day, month ? MONTHS[month - 1] : null, year].filter(Boolean).join(" ");
	}

	function enabled() {
		return ZoteroMCP.Prefs.get("dates.normalize", true) !== false;
	}

	/**
	 * Value to pass to item.setField() for a date field, and a note for the tool result
	 * @return {{value: String, note: Object|null}}
	 */
	function forDateField(field, input) {
		const text = String(input === null || input === undefined ? "" : input).trim();
		if (!text || !enabled()) {
			return { value: text, note: null };
		}
		const parsed = parse(text);
		if (!parsed) {
			return { value: text, note: { field, input: text, stored: text, note: "not a single calendar date; stored unchanged" } };
		}
		const display = format(parsed);
		const sql = `${String(parsed.year).padStart(4, "0")}-${pad(parsed.month || 0)}-${pad(parsed.day || 0)}`;
		const note = { field, input: text, stored: display, interpreted_as: describe(parsed) };
		if (parsed.swapped) {
			note.note = "read as MM/DD/YYYY because the second number is above 12";
		}
		if (parsed.ambiguous) {
			note.note = "ambiguous day and month; read as DD/MM/YYYY. Send ISO dates (YYYY-MM-DD) to avoid this";
		}
		return { value: `${sql} ${display}`, note: display === text && !parsed.ambiguous ? null : note };
	}

	// accessDate must stay in Zotero's SQL form; accept other notations for it
	function forAccessDate(input) {
		const text = String(input || "").trim();
		const parsed = parse(text);
		if (!parsed || !parsed.day || /\d{1,2}:\d{2}/.test(text)) {
			return text;
		}
		return `${parsed.year}-${pad(parsed.month)}-${pad(parsed.day)}`;
	}

	function isDateField(fieldName) {
		const id = Zotero.ItemFields.getID(fieldName);
		return !!id && Zotero.ItemFields.isDate(id);
	}

	/**
	 * Normalizes all date fields of a saved or unsaved item in place (no save)
	 * @return {Object[]} notes about changed values
	 */
	function normalizeItem(item) {
		const notes = [];
		if (!enabled() || !item.isRegularItem()) {
			return notes;
		}
		for (const fieldID of Zotero.ItemFields.getItemTypeFields(item.itemTypeID)) {
			if (!Zotero.ItemFields.isDate(fieldID)) {
				continue;
			}
			const name = Zotero.ItemFields.getName(fieldID);
			const current = item.getField(name);
			if (!current) {
				continue;
			}
			const { value, note } = forDateField(name, current);
			if (value !== current && Zotero.Date.isMultipart(value)) {
				item.setField(name, value);
				if (note) {
					notes.push(note);
				}
			}
		}
		return notes;
	}

	return { parse, format, describe, forDateField, forAccessDate, isDateField, normalizeItem, enabled };
})();
