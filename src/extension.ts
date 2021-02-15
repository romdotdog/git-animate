import * as vscode from "vscode";
import simpleGit, { SimpleGit, SimpleGitOptions } from "simple-git";

function escapeFull(text: string) {
	return text.replace(/[\u0000-\u00FF]/g, function (c) {
		return "%u" + c.charCodeAt(0).toString(16).padStart(4, "0");
	});
}

export function activate(context: vscode.ExtensionContext) {
	const commitProvider = new (class
		implements vscode.TextDocumentContentProvider {
		onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
		onDidChange = this.onDidChangeEmitter.event;

		provideTextDocumentContent(uri: vscode.Uri): string {
			return uri.fragment
				.split(";")
				.map((t) => {
					const [author, message] = t.split(",").map(unescape);
					return `<${author}>: ${message}`;
				})
				.join("\n\n");
		}
	})();

	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(
			"ganimate-commits",
			commitProvider
		)
	);

	let disposable = vscode.commands.registerCommand(
		"git-animate.animate",
		async () => {
			// workbench.action.newWindow
			if (
				!vscode.workspace.workspaceFolders ||
				!vscode.workspace.workspaceFolders.length
			) {
				return vscode.window.showWarningMessage(
					`No repository is currently opened!`
				);
			}

			if (vscode.workspace.workspaceFolders.length !== 1) {
				return vscode.window.showWarningMessage(
					`Please only have one folder in your workspace.`
				);
			}

			const cwd = vscode.workspace.workspaceFolders[0].uri.fsPath;
			const gitpath =
				vscode.workspace.getConfiguration("git").get<string>("path") || "git";

			const options: SimpleGitOptions = {
				baseDir: cwd,
				binary: gitpath,
				maxConcurrentProcesses: 6,
				config: []
			};

			const git: SimpleGit = simpleGit(options);
			const log = await git.log();
			// vscode.window.showInformationMessage(log.total + " commits found..");

			const uri = vscode.Uri.parse(
				`ganimate-commits:Commits#` +
					log.all
						.map((c) => `${escapeFull(c.author_name)},${escapeFull(c.message)}`)
						.join(";")
			);

			console.log(uri.fragment);
			const doc = await vscode.workspace.openTextDocument(uri); // calls back into the provider
			vscode.languages.setTextDocumentLanguage(doc, "markdown");
			await vscode.window.showTextDocument(doc, {
				viewColumn: vscode.ViewColumn.Two,
				preview: false
			});
		}
	);

	context.subscriptions.push(disposable);
}

export function deactivate() {}
