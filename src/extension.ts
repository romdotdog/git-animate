import * as vscode from "vscode";
import simpleGit, { SimpleGit, SimpleGitOptions } from "simple-git";
import parseGitPatch from "parse-git-patch";
import * as util from "util";
import { execFile as _execFile } from "child_process";
const execFile = util.promisify(_execFile);

export function activate(context: vscode.ExtensionContext) {
	let disposable = vscode.commands.registerCommand(
		"git-animate.animate",
		async () => {
			// workbench.action.newWindow
			if (
				!vscode.workspace.workspaceFolders ||
				!vscode.workspace.workspaceFolders.length
			) {
				return vscode.window.showErrorMessage(
					`No repository is currently opened!`
				);
			}

			if (vscode.workspace.workspaceFolders.length !== 1) {
				return vscode.window.showErrorMessage(
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
			const log = await git.log(["--full-diff"]);

			const uri = vscode.Uri.parse(`untitled:Commits`);
			const doc = await vscode.workspace.openTextDocument(uri);

			vscode.languages.setTextDocumentLanguage(doc, "markdown");
			const commitEditor = await vscode.window.showTextDocument(doc, {
				viewColumn: vscode.ViewColumn.Two,
				preview: false
			});

			const editors: Record<string, vscode.TextEditor> = {};

			for (let i = 0; i < log.all.length; i++) {
				const commit = log.all[i];

				let command =
					i === 0
						? `git log -u -1 ${commit.hash}`
						: `git diff ${log.all[i - 1].hash} ${commit.hash}`;

				const { stdout } = await execFile(command);
				const patch = parseGitPatch(stdout);

				// Add commit
				commitEditor.edit((editBuilder: vscode.TextEditorEdit) => {
					editBuilder.insert(
						new vscode.Position(commitEditor.document.lineCount, 0),
						`<${commit.author_name}>: ${commit.message}\n\n`
					);
				});
			}
		}
	);

	context.subscriptions.push(disposable);
}

export function deactivate() {}
