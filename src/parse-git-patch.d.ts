declare module "parse-git-patch" {
	interface Line {
		added: boolean;
		lineNumber: number;
		line: string;
	}

	interface File {
		added: boolean;
		deleted: boolean;

		beforeName: string;
		afterName: string;

		modifiedLines: Line[];
	}

	interface Patch {
		hash: string;
		date: string;
		message: string;
		authorEmail: string;
		authorName: string;
		files: File[];
	}

	function parseGitPatch(patchString: string): Patch;
	export = parseGitPatch;
}
