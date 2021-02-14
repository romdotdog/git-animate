import * as vscode from "vscode";
import simpleGit, { SimpleGit, SimpleGitOptions } from "simple-git";

export function activate(context: vscode.ExtensionContext) {
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
			vscode.window.showInformationMessage(log.total + " commits found..");
		}
	);

	context.subscriptions.push(disposable);
}

export function deactivate() {}
