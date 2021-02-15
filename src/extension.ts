import * as vscode from "vscode";
import simpleGit, {
	DefaultLogFields,
	ListLogLine,
	SimpleGit,
	SimpleGitOptions
} from "simple-git";
import parseGitPatch = require("parse-git-patch");

import { basename } from "path";

import { spawn } from "child_process";

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

type Writeable<T> = { -readonly [P in keyof T]: T[P] };

export function activate(context: vscode.ExtensionContext) {
	let disposable = vscode.commands.registerCommand(
		"git-animate.animate",
		async () => {
			try {
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
				const log = await git.log();

				const commitDoc = await vscode.workspace.openTextDocument(
					vscode.Uri.parse(`untitled:Commits`)
				);

				await vscode.commands.executeCommand(
					"workbench.action.closeAllEditors"
				);

				vscode.languages.setTextDocumentLanguage(commitDoc, "xml");

				const documents: Record<string, vscode.TextDocument> = {};

				async function createDocument(path: string) {
					return (documents[path] = await vscode.workspace.openTextDocument(
						vscode.Uri.parse(`untitled:${path}`)
					));
				}

				console.log(`Got ${log.all.length} commits in log.`);
				let commits = log.all as Writeable<(DefaultLogFields & ListLogLine)[]>; // why????
				commits.reverse();

				for (let i = 0; i < commits.length; i++) {
					const commit = commits[i];
					console.log(`Doing commit ${commit.hash}`);

					// Add commit
					const commitEditor = await vscode.window.showTextDocument(commitDoc, {
						viewColumn: vscode.ViewColumn.Two,
						preview: false
					});

					commitEditor.edit((editBuilder: vscode.TextEditorEdit) => {
						editBuilder.insert(
							new vscode.Position(commitEditor.document.lineCount, 0),
							`<${commit.author_name}>: ${commit.message}\n\n`
						);
					});

					await sleep(2000);

					let args = [
						"--no-pager",
						"format-patch",
						"--stdout",
						"-1",
						commit.hash
					];

					console.log("Executing `git " + args.join(" ") + "`");

					let stdout = "";
					const spawned = spawn(gitpath, args, {
						cwd
					});

					spawned.stdout!.on("data", (data) => {
						stdout += data.toString();
					});

					await new Promise<void>((resolve, reject) => {
						spawned.on("error", (err) => {
							console.error(err);
							reject(err);
						});

						spawned.on("exit", (code: number) => {
							resolve();
						});

						spawned.on("close", (code: number) => {
							resolve();
						});
					});

					console.log(stdout);
					const patch = parseGitPatch(stdout);
					console.log(`Parsed with ${patch.files.length} files changed.`);

					for (const file of patch.files) {
						await sleep(700);

						let doc = documents[file.beforeName];
						if (!doc) {
							doc = await createDocument(file.beforeName);
						}

						let editor = await vscode.window.showTextDocument(doc, {
							viewColumn: vscode.ViewColumn.One
						});

						if (file.beforeName !== file.afterName) {
							const newEditor = await vscode.window.showTextDocument(
								await createDocument(file.afterName),
								{
									viewColumn: vscode.ViewColumn.One
								}
							);

							newEditor.edit((editBuilder: vscode.TextEditorEdit) => {
								editBuilder.insert(
									new vscode.Position(0, 0),
									editor.document.getText()
								);
							});

							await vscode.commands.executeCommand(
								"workbench.action.closeActiveEditor",
								editor
							);

							editor = newEditor;
						}

						for (const line of file.modifiedLines) {
							const jump = Math.abs(
								editor.selection.active.line - line.lineNumber
							);

							const visibleRange = editor.visibleRanges[0];
							if (
								visibleRange.end.line < line.lineNumber ||
								visibleRange.start.line > line.lineNumber
							) {
								const targetLine = Math.max(line.lineNumber - 20, 0);

								await vscode.commands.executeCommand("editorScroll", {
									to: visibleRange.start.line > targetLine ? "up" : "down",
									by: "line",
									value: Math.abs(visibleRange.start.line - targetLine),
									revealCursor: false
								});
							}

							await sleep(Math.min(300, jump * 5));

							if (line.added) {
								const [, leadingWhite, lineContent] = (line.line + "\n").match(
									/^(\s*)(.*)/s
								)!;

								await editor.edit((editBuilder: vscode.TextEditorEdit) => {
									editBuilder.insert(
										new vscode.Position(line.lineNumber, 0),
										leadingWhite
									);
								});

								// Insertion
								for (
									let charIndex = 0;
									charIndex < lineContent.length;
									charIndex++
								) {
									const char = lineContent[charIndex];
									await editor.edit((editBuilder: vscode.TextEditorEdit) => {
										editBuilder.insert(
											new vscode.Position(line.lineNumber, charIndex),
											char
										);
									});

									await sleep(1);
								}
							} else {
								// Delete
								await editor.edit((editBuilder: vscode.TextEditorEdit) => {
									editBuilder.delete(
										new vscode.Range(
											new vscode.Position(line.lineNumber, 0),
											new vscode.Position(line.lineNumber, line.line.length)
										)
									);
								});
								await sleep(50);
							}
						}
					}
				}
			} catch (err) {
				console.error(err);
				return vscode.window.showErrorMessage(err);
			}
		}
	);

	context.subscriptions.push(disposable);
}

export function deactivate() {}
