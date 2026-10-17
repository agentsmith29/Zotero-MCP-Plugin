/* global window, document, Zotero, PathUtils */

var ZoteroMCP_ExportSetup = {
	io: null,

	init() {
		this.io = window.arguments[0];
		const io = this.io;
		document.getElementById("zmcp-scope").textContent = `Export the stored files of ${io.scopeLabel}.`;
		document.getElementById("zmcp-folder").value = io.folder;
		document.getElementById("zmcp-name").value = io.name;
		document.getElementById("zmcp-structure").value = io.structure === "flat" ? "flat" : "collections";

		const bib = document.getElementById("zmcp-bibliography");
		bib.checked = !!io.includeBibliography;
		bib.disabled = !io.bbtAvailable;
		document.getElementById("zmcp-bbt-missing").hidden = !!io.bbtAvailable;

		this.updateTarget();
		document.addEventListener("dialogaccept", event => this.accept(event));
		window.sizeToContent();
	},

	updateTarget() {
		const name = document.getElementById("zmcp-name").value.trim();
		const target = name ? PathUtils.join(this.io.folder, Zotero.File.getValidFileName(name)) : "";
		document.getElementById("zmcp-target").textContent = target ? `Files go to ${target}` : "Enter a folder name";
	},

	async changeFolder() {
		const folder = await this.io.pickFolder(window, this.io.folder);
		if (folder) {
			this.io.folder = folder;
			document.getElementById("zmcp-folder").value = folder;
			this.updateTarget();
		}
	},

	accept(event) {
		const name = document.getElementById("zmcp-name").value.trim();
		if (!name) {
			event.preventDefault();
			return;
		}
		this.io.name = name;
		this.io.structure = document.getElementById("zmcp-structure").value;
		this.io.includeBibliography = this.io.bbtAvailable && document.getElementById("zmcp-bibliography").checked;
		this.io.accepted = true;
	}
};
