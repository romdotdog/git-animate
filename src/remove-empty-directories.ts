import { promises as fsPromises } from "fs";
import * as path from "path";

/**
 * Recursively removes empty directories from the given directory.
 *
 * If the directory itself is empty, it is also removed.
 *
 * Code taken from: https://gist.github.com/jakub-g/5903dc7e4028133704a4
 *
 * @param {string} directory Path to the directory to clean up
 */
export async function removeEmptyDirectories(directory: string) {
	// lstat does not follow symlinks (in contrast to stat)
	const fileStats = await fsPromises.lstat(directory);
	if (!fileStats.isDirectory()) {
		return;
	}
	let fileNames = await fsPromises.readdir(directory);
	if (fileNames.length > 0) {
		const recursiveRemovalPromises = fileNames.map((fileName) =>
			removeEmptyDirectories(path.join(directory, fileName))
		);
		await Promise.all(recursiveRemovalPromises);

		// re-evaluate fileNames; after deleting subdirectory
		// we may have parent directory empty now
		fileNames = await fsPromises.readdir(directory);
	}

	if (fileNames.length === 0) {
		console.log("Removing: ", directory);
		await fsPromises.rmdir(directory);
	}
}
