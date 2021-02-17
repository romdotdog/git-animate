import * as vscode from "vscode";
import simpleGit, {
	DefaultLogFields,
	ListLogLine,
	SimpleGit,
	SimpleGitOptions
} from "simple-git";
import { spawn } from "child_process";

import { join, relative, resolve, isAbsolute, dirname } from "path";
import { promises } from "fs";

import { parseGitPatch, Line } from "parse-git-patch";
import { compile as parseGitIgnore } from "gitignore-parser";

import { removeEmptyDirectories } from "./remove-empty-directories";

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

async function updateScroll(visibleRange: vscode.Range, lineNumber: number) {
	const targetLine = Math.max(lineNumber - 20, -1);

	await vscode.commands.executeCommand("editorScroll", {
		to: visibleRange.start.line > targetLine ? "up" : "down",
		by: "line",
		value: Math.abs(visibleRange.start.line - targetLine),
		revealCursor: false
	});
}

// https://stackoverflow.com/questions/37521893/determine-if-a-path-is-subdirectory-of-another-in-node-js
function isChildOf(child: string, parent: string): boolean {
	const r = relative(parent, child);
	return !!(r && !r.startsWith("..") && !isAbsolute(r));
}

type Writeable<T> = { -readonly [P in keyof T]: T[P] };

interface UnfinishedDeletedLineGroup {
	from?: number;
	to?: number;
	content?: string;
}

interface DeletedLineGroup {
	from: number;
	to: number;
	content: string;
}

function isDeletedLineGroup(
	obj: UnfinishedDeletedLineGroup | Line
): obj is DeletedLineGroup {
	obj = obj as UnfinishedDeletedLineGroup;
	return !!(obj.from && obj.to && obj.content);
}

// Chunk deleted lines together so we don't have to delete a huge block line by line
function* chunkDeleted(
	iterator: IterableIterator<Line>
): Generator<DeletedLineGroup | Line, void> {
	let deletedBuilder: UnfinishedDeletedLineGroup = {};
	while (true) {
		const next = iterator.next();
		if (
			isDeletedLineGroup(deletedBuilder) &&
			(next.done ||
				next.value.added ||
				next.value.lineNumber !== deletedBuilder.to + 1) // either no next line, next line is inserting, or next line doesn't continue the line group.
		) {
			yield deletedBuilder;
			deletedBuilder = {};
		}

		if (next.done) {
			break;
		}

		if (next.value.added) {
			yield next.value;
		} else {
			deletedBuilder.from = deletedBuilder.from || next.value.lineNumber;
			deletedBuilder.to = next.value.lineNumber;
			deletedBuilder.content =
				(deletedBuilder.content || "") + next.value.line + "\n";
		}
	}
}

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

			const cwd = vscode.workspace.workspaceFolders[0].uri.fsPath;

			if (isChildOf(cwd, playbackFolder)) {
				return vscode.window.showErrorMessage(
					`Cannot visualize a git-animate folder.`
				);
			}

			const dest = resolve(
				join(playbackFolder, vscode.workspace.workspaceFolders[0].name)
			);

			console.log(dest);

			await promises.rmdir(dest, { recursive: true });
			console.log("Done clearing, now making directory..");
			await promises.mkdir(dest, { recursive: true });

			const out = `${cwd}

## Welcome to your git-animate project!
### Please do not edit line 1 of this file.
This is what the extension reads to figure out the git repository you want to animate!

### How do I start playback?
Make sure you're focused on this file, type \`CTRL+SHIFT+P\`, then select \`Animate: Start animation\`.

You're good to go now, happy animating!`;

			console.log("Making .gitanimate.md and .gitignore..");
			await promises.writeFile(join(dest, ".gitanimate.md"), out, {
				encoding: "utf8"
			});

			await promises.writeFile(
				join(dest, ".gitignore"),
				"# Here, you can specify globs that will be entirely ignored during animation.\n# LICENSE\n# /*.json",
				{
					encoding: "utf8"
				}
			);

			console.log("Making settings.json..");
			await promises.mkdir(join(dest, ".vscode"));

			const settings =
				configuration.get<Record<string, any>>("defaultWorkspaceJSON") || {};

			await promises.writeFile(
				join(dest, ".vscode", "settings.json"),
				JSON.stringify(settings)
			);

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
				!vscode.window.activeTextEditor.document.fileName.match(
					/\.gitanimate\.md/
				)
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

			// delete .gitanimate.md
			await promises.unlink(vscode.window.activeTextEditor.document.uri.fsPath);

			const playbackProject = vscode.workspace.workspaceFolders[0].uri.fsPath;

			const gitignorePath = join(playbackProject, ".gitignore");
			const gitignore = parseGitIgnore(
				await promises.readFile(gitignorePath, { encoding: "utf-8" })
			);

			// delete .gitignore
			await promises.unlink(gitignorePath);

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

			const commitFile = join(playbackProject, "Commits.xml");
			await promises.writeFile(commitFile, "");
			const commitDoc = await vscode.workspace.openTextDocument(
				vscode.Uri.file(commitFile)
			);

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

				const renamedIgnore = new Set<string>([]); // if ignored files are renamed, we still need to ignore them

				for (const file of patch.files) {
					if (
						renamedIgnore.has(file.beforeName) ||
						renamedIgnore.has(file.afterName) ||
						gitignore.denies(file.beforeName)
					) {
						renamedIgnore.add(file.beforeName);
						renamedIgnore.add(file.afterName);
						continue;
					}

					let fullPath = join(playbackProject, file.beforeName);
					let doc = documents[fullPath];

					if (!doc) {
						await promises.mkdir(
							dirname(fullPath), // create all directories for the path
							{ recursive: true }
						);
						await promises.writeFile(fullPath, "");
						doc = await createDocument(fullPath);
					}

					if (file.deleted) {
						await doc.save();
						await promises.unlink(fullPath);

						// Remove directories that are empty
						await removeEmptyDirectories(playbackProject);
						continue;
					}

					let editor = await vscode.window.showTextDocument(doc, {
						viewColumn: vscode.ViewColumn.One
					});

					console.log(file);

					if (file.beforeName !== file.afterName) {
						await editor.document.save();
						await vscode.commands.executeCommand(
							"workbench.action.closeActiveEditor",
							editor
						);

						delete documents[fullPath];

						const newPath = join(playbackProject, file.afterName);
						await promises.mkdir(
							dirname(newPath), // create all directories for the path
							{ recursive: true }
						);
						await promises.rename(fullPath, newPath);

						// Remove directories that are empty
						await removeEmptyDirectories(playbackProject);

						const newEditor = await vscode.window.showTextDocument(
							await createDocument(newPath),
							{
								viewColumn: vscode.ViewColumn.One
							}
						);

						editor = newEditor;
						fullPath = newPath;
					}

					let linesDeleted = 0;
					let linesAdded = 0;

					const lineIterator = file.modifiedLines[Symbol.iterator]();
					for (const line of chunkDeleted(lineIterator)) {
						const jump = Math.abs(
							editor.selection.active.line -
								(isDeletedLineGroup(line) ? line.from : line.lineNumber)
						);
						const visibleRange = editor.visibleRanges[0];

						await sleep(Math.min(300, jump * 5));

						if (isDeletedLineGroup(line)) {
							// Delete section

							// Patch is ahead by one line
							line.from--;
							line.to--;

							line.from -= linesDeleted - linesAdded;
							line.to -= linesDeleted - linesAdded;

							updateScroll(visibleRange, line.to);

							const range = new vscode.Range(
								new vscode.Position(line.from - 1, 0), // lines start at 0 in positions
								new vscode.Position(line.to, 0)
							);

							// Check if out of sync
							const expected = line.content.replace(/\s+/g, "");
							const actual = editor.document.getText(range).replace(/\s+/g, "");
							// I'm stripping all whitespace because I've had an occurrence where the two strings were equal
							// in the interpreter yet this if statement returned true
							if (actual !== expected) {
								console.log(
									`Expected \`${expected}\` at line ${line.from} - ${line.to} (- ${linesDeleted} + ${linesAdded}), got \`${actual}\``
								);
								return;
							}
							editor.selection = new vscode.Selection(range.start, range.end);

							await sleep(100);

							// Delete
							await editor.edit((editBuilder: vscode.TextEditorEdit) => {
								editBuilder.delete(range);
							});

							linesDeleted += line.to - (line.from - 1);
						} else {
							line.lineNumber--; // Patch is ahead by one line
							let lineNumber = line.lineNumber - 1; // Position is zero-based

							// Insert line
							console.log(`Inserting "${line.line}" at ${line.lineNumber}`);
							updateScroll(visibleRange, lineNumber);

							const [, leadingWhite, lineContent] = (
								line.line.trimEnd() + "\n"
							).match(/^(\s*)(.*)/s)!;

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
						}
					}

					// Save file
					await editor.document.save();
				}

				// Add commit to log
				const commitEditor = await vscode.window.showTextDocument(commitDoc, {
					viewColumn: vscode.ViewColumn.Two,
					preview: false
				});

				await commitEditor.edit((editBuilder: vscode.TextEditorEdit) => {
					editBuilder.insert(
						new vscode.Position(commitEditor.document.lineCount, 0),
						`<${commit.author_name}>: ${commit.message}\n\n`
					);
				});

				await commitDoc.save();
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
