import * as vscode from "vscode";
import simpleGit, {
	DefaultLogFields,
	ListLogLine,
	SimpleGit,
	SimpleGitOptions
} from "simple-git";
import parseGitPatch = require("parse-git-patch");
import { spawn } from "child_process";

import { join, relative, resolve, isAbsolute } from "path";
import { promises } from "fs";

function chunk<T>(arr: T[], len: number): T[][] {
	var chunks = [],
		i = 0,
		n = arr.length;

	while (i < n) {
		chunks.push(arr.slice(i, (i += len)));
	}

	return chunks;
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// https://stackoverflow.com/questions/37521893/determine-if-a-path-is-subdirectory-of-another-in-node-js
function isChildOf(child: string, parent: string): boolean {
	const r = relative(parent, child);
	return !!(r && !r.startsWith("..") && !isAbsolute(r));
}

type Writeable<T> = { -readonly [P in keyof T]: T[P] };

export function activate(context: vscode.ExtensionContext) {
	let animate = vscode.commands.registerCommand(
		"git-animate.animate",
		async () => {
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

			const configuration = vscode.workspace.getConfiguration("gitanimate");
			let playbackFolder = configuration.get<string>("playbackFolder");

			if (!playbackFolder) {
				return vscode.window.showErrorMessage(
					`gitanimate.playbackFolder is undefined.`
				);
			}

			// https://stackoverflow.com/questions/21363912/how-to-resolve-a-path-that-includes-an-environment-variable-in-nodejs
			playbackFolder = playbackFolder.replace(
				/%([^%]+)%/g,
				(original, matched) => {
					const r = process.env[matched];
					return r ? r : "";
				}
			);

			const dest = resolve(
				join(playbackFolder, vscode.workspace.workspaceFolders[0].name)
			);

			console.log(dest);

			await promises.rmdir(dest, { recursive: true });
			console.log("Done clearing, now making directory..");
			await promises.mkdir(dest, { recursive: true });

			const cwd = vscode.workspace.workspaceFolders[0].uri.fsPath;
			const out = `${cwd}

## Welcome to your git-animate project!
### Please do not edit line 1 of this file.
This is what the extension reads to figure out the git repository you want to animate!

### How do I start playback?
Make sure you're focused on this file, type \`CTRL+SHIFT+P\`, then select \`Animate: Start animation\`.

You're good to go now, happy animating!`;

			console.log("Making .gitanimate.md..");
			await promises.writeFile(join(dest, ".gitanimate.md"), out, {
				encoding: "utf8"
			});

			console.log("Launching new instance of vscode..");
			const destURI = vscode.Uri.file(dest);
			const pick = await vscode.window.showQuickPick(["Yes", "No"], {
				placeHolder: "Open new window?"
			});

			vscode.commands.executeCommand(
				"vscode.openFolder",
				destURI,
				pick === "Yes"
			);
		}
	);

	let start = vscode.commands.registerCommand("git-animate.start", async () => {
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

			if (
				!vscode.window.activeTextEditor ||
				vscode.window.activeTextEditor.document.fileName !== ".gitanimate.md"
			) {
				return vscode.window.showErrorMessage(
					`.gitanimate.md should be focused when attempting playback.`
				);
			}

			const configuration = vscode.workspace.getConfiguration("gitanimate");
			let playbackFolder = configuration.get<string>("playbackFolder");

			if (!playbackFolder) {
				return vscode.window.showErrorMessage(
					`gitanimate.playbackFolder is undefined.`
				);
			}

			// https://stackoverflow.com/questions/21363912/how-to-resolve-a-path-that-includes-an-environment-variable-in-nodejs
			playbackFolder = playbackFolder.replace(
				/%([^%]+)%/g,
				(original, matched) => {
					const r = process.env[matched];
					return r ? r : "";
				}
			);

			if (
				!isChildOf(
					vscode.workspace.workspaceFolders[0].uri.fsPath,
					playbackFolder
				)
			) {
				return vscode.window.showErrorMessage(
					`Playback must take place in gitanimate.playbackFolder.`
				);
			}

			const repository = vscode.window.activeTextEditor.document
				.getText(
					new vscode.Range(new vscode.Position(0, 0), new vscode.Position(1, 0))
				)
				.trim(); // when running this command, editor should be focused on .gitanimate.md

			const playbackProject = vscode.workspace.workspaceFolders[0].uri.fsPath;

			const gitpath =
				vscode.workspace.getConfiguration("git").get<string>("path") || "git";

			const options: SimpleGitOptions = {
				baseDir: repository,
				binary: gitpath,
				maxConcurrentProcesses: 6,
				config: []
			};

			const git: SimpleGit = simpleGit(options);
			const log = await git.log();

			await vscode.commands.executeCommand("workbench.action.closeAllEditors");

			const commitDoc = await vscode.workspace.openTextDocument(
				vscode.Uri.parse(`untitled:Commits`)
			);
			vscode.languages.setTextDocumentLanguage(commitDoc, "xml");

			const documents: Record<string, vscode.TextDocument> = {};

			async function createDocument(path: string) {
				return (documents[path] = await vscode.workspace.openTextDocument(
					vscode.Uri.parse(`file:${path}`)
				));
			}

			console.log(`Got ${log.all.length} commits in log.`);
			let commits = log.all as Writeable<(DefaultLogFields & ListLogLine)[]>; // why????
			commits.reverse();

			for (let i = 0; i < commits.length; i++) {
				const commit = commits[i];
				console.log(`Doing commit ${commit.hash}`);

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
					cwd: repository
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

				const patch = parseGitPatch(stdout);

				for (const file of patch.files) {
					let fullPath = join(playbackProject, file.beforeName);
					let doc = documents[fullPath];

					if (!doc) {
						await promises.mkdir(fullPath, { recursive: true });
						await promises.writeFile(fullPath, "");
						doc = await createDocument(fullPath);
					}

					let editor = await vscode.window.showTextDocument(doc, {
						viewColumn: vscode.ViewColumn.One
					});

					if (file.deleted) {
						await promises.unlink(fullPath);
						continue;
					}

					if (file.beforeName !== file.afterName) {
						const newPath = join(playbackProject, file.afterName);
						await promises.rename(fullPath, newPath);

						const newEditor = await vscode.window.showTextDocument(
							await createDocument(newPath),
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
						fullPath = newPath;
					}

					let linesDeleted = 0;
					let linesAdded = 0;
					for (const line of file.modifiedLines) {
						const jump = Math.abs(
							editor.selection.active.line - line.lineNumber
						);

						const visibleRange = editor.visibleRanges[0];
						if (
							visibleRange.end.line < line.lineNumber ||
							visibleRange.start.line > line.lineNumber
						) {
							const targetLine = Math.max(line.lineNumber - 20, -1);

							await vscode.commands.executeCommand("editorScroll", {
								to: visibleRange.start.line > targetLine ? "up" : "down",
								by: "line",
								value: Math.abs(visibleRange.start.line - targetLine),
								revealCursor: false
							});
						}

						await sleep(Math.min(300, jump * 5));

						line.lineNumber--; // Patch is ahead by one line
						let lineNumber = line.lineNumber - 1; // Position is zero-based
						if (line.added) {
							const [, leadingWhite, lineContent] = (line.line + "\n").match(
								/^(\s*)(.*)/s
							)!;

							await editor.edit((editBuilder: vscode.TextEditorEdit) => {
								editBuilder.insert(
									new vscode.Position(lineNumber, 0),
									leadingWhite
								);
							});

							const pos = new vscode.Position(lineNumber, leadingWhite.length);
							editor.selection = new vscode.Selection(pos, pos);

							const chunkLength = 4;
							const chunks = chunk(lineContent.split(""), chunkLength);

							// Insertion
							for (let charIndex = 0; charIndex < chunks.length; charIndex++) {
								const chunk = chunks[charIndex];
								await editor.edit((editBuilder: vscode.TextEditorEdit) => {
									editBuilder.insert(
										new vscode.Position(
											lineNumber,
											leadingWhite.length + charIndex * chunkLength
										),
										chunk.join("")
									);
								});

								await sleep(1);
							}

							linesAdded++;
						} else {
							lineNumber -= linesDeleted - linesAdded;
							const range = new vscode.Range(
								new vscode.Position(lineNumber, 0),
								new vscode.Position(lineNumber + 1, 0)
							);

							editor.selection = new vscode.Selection(range.start, range.end);

							await sleep(100);

							// Delete
							await editor.edit((editBuilder: vscode.TextEditorEdit) => {
								editBuilder.delete(range);
							});

							linesDeleted++;
						}
					}

					// Save file
					editor.document.save();
				}

				// Add commit to log
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
			}
		} catch (err) {
			console.error(err);
			return vscode.window.showErrorMessage(err);
		}
	});

	context.subscriptions.push(animate);
	context.subscriptions.push(start);
}

export function deactivate() {}
