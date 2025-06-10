import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process'; // For running the external tool

export function activate(context: vscode.ExtensionContext) {
    console.log('Congratulations, your extension "external-clipboard-merge" is now active!');

    let disposable = vscode.commands.registerCommand('externalMerge.trigger', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active text editor.');
            return;
        }

        const document = editor.document;
        const activeFileContent = document.getText();
        const activeFilePathOriginal = document.fileName; // This is the true original file

        let clipboardContent: string;
        try {
            clipboardContent = await vscode.env.clipboard.readText();
            if (!clipboardContent) {
                vscode.window.showInformationMessage('Clipboard is empty.');
                return;
            }
        } catch (error) {
            vscode.window.showErrorMessage('Failed to read from clipboard.');
            console.error(error);
            return;
        }

        const config = vscode.workspace.getConfiguration('externalMerge');
        const toolPath = config.get<string>('toolPath');
        let toolArgumentsTemplate = config.get<string>('toolArguments');
        const useThreeWay = config.get<boolean>('useThreeWayMergeIfBaseProvided');


        if (!toolPath) {
            vscode.window.showErrorMessage(
                'External merge tool path is not configured. Please set "externalMerge.toolPath" in your settings.'
            );
            return;
        }

        if (!toolArgumentsTemplate) {
            vscode.window.showErrorMessage(
                'External merge tool arguments are not configured. Please set "externalMerge.toolArguments" in your settings.'
            );
            return;
        }

        const tempDir = os.tmpdir();
        let tempFile1Path: string = '';    // For active editor content / "theirs" in 3-way
        let tempFile2Path: string = '';    // For clipboard content / "mine" in 3-way
        let outputFilePath: string = '';   // Where the merged result should go
        let baseFilePath: string = '';     // For 3-way merge "base"

        try {
            // Create unique temporary file names
            const timestamp = new Date().getTime();
            const originalFileExt = path.extname(activeFilePathOriginal);
            const originalFileNameWithoutExt = path.basename(activeFilePathOriginal, originalFileExt);

            // Prepare file paths
            // filePath1 will be a copy of the active editor's current state
            tempFile1Path = path.join(tempDir, `vscode-merge-${timestamp}-editor${originalFileExt || '.tmp'}`);
            await fs.writeFile(tempFile1Path, activeFileContent);

            // filePath2 is the clipboard content
            tempFile2Path = path.join(tempDir, `vscode-merge-${timestamp}-clipboard${originalFileExt || '.tmp'}`);
            await fs.writeFile(tempFile2Path, clipboardContent);

            // outputFilePath: The original file will be the ultimate output.
            // Some tools modify in place, others need an output arg.
            // We will read this file after the tool closes and replace editor content.
            outputFilePath = path.join(tempDir, `vscode-merge-${timestamp}-output${originalFileExt || '.tmp'}`);
            // Initialize output file with current editor content so if the tool wants an existing output, it has one
            // Or, if the tool saves to one of the inputs, we will handle it.
            await fs.writeFile(outputFilePath, activeFileContent);


            let actualToolArguments: string[] = [];
            let finalOutputToRead = outputFilePath; // Default to the designated output temp file

            if (useThreeWay && toolArgumentsTemplate.includes("{baseFilePath}")) {
                baseFilePath = path.join(tempDir, `vscode-merge-${timestamp}-base${originalFileExt || '.tmp'}`);
                // For 3-way, the "base" is the original file content BEFORE modifications
                // However, for this workflow (editor vs clipboard), activeFileContent IS the "base" if we consider clipboard as "changes".
                // More realistically, the user implies:
                // Base: Original File (perhaps before *any* edits by LLM or user)
                // Left/Mine: Current Editor (potentially modified from original)
                // Right/Theirs: Clipboard (LLM suggestion)
                // Output: A new version.
                // For simplicity with the current request (editor vs clipboard):
                // We can consider the *current editor content* as the "base" if the tool treats inputs as "theirs" and "mine" against a base.
                // Or, if your tool uses <left> <right> <base> <output>
                // Let's assume filePath1 is "local" (editor), filePath2 is "remote" (clipboard)
                // And the original active file is the implicit "base" and also the final "output" destination.

                // A common 3-way setup: <local> <remote> <base> <output>
                // For Rider: `rider merge local remote base output`
                // local: tempFile1Path (editor content)
                // remote: tempFile2Path (clipboard content)
                // base: activeFilePathOriginal itself if the tool can read it directly without locking.
                //       Safer to make another copy for base.
                baseFilePath = path.join(tempDir, `vscode-merge-${timestamp}-base${originalFileExt || '.tmp'}`);
                await fs.writeFile(baseFilePath, activeFileContent); // Assuming current editor IS the base for this comparison.
                                                                   // Or, if user implies LLM changed current file, then original file on disk is base.
                                                                   // This part needs user intent clarification for a "true" 3-way.

                // For now, let's assume a 3-way uses {baseFilePath}, {filePath1}, {filePath2}, and {outputFilePath}
                // where {filePath1} is one version, {filePath2} is another, and {baseFilePath} is their common ancestor.
                // For this tool, active editor is one version, clipboard is another.
                // The "base" is conceptually the content before either of those changes.
                // For simplicity, we'll make {filePath1} the editor, {filePath2} the clipboard,
                // and if the user's merge tool takes an explicit output, it's {outputFilePath}.
                // If the user wants a *true* 3-way (original disk, current editor, clipboard), that's more complex.

                // Re-evaluating: For merging clipboard into current editor, a 2-way is simpler:
                // File A (current editor content) vs File B (clipboard content) -> Merged into File A's buffer
                // If the tool supports 3-way and user configures for it, they might mean:
                // Base = Current editor content (temp copy)
                // Theirs = Clipboard content (temp copy)
                // Mine = Current editor content (another temp copy, which will be modified by tool)
                // Output = The "Mine" temp copy.

                // Sticking to the current structure: filePath1 is editor, filePath2 is clipboard.
                // if useThreeWay, we need a base. We'll use filePath1 (editor) as the base.
                // And tool will modify filePath1 (editor's temp copy) if it merges in place.
                if (useThreeWay && toolArgumentsTemplate.includes("{baseFilePath}")) {
                    // Make filePath1 the "base"
                    // Make a new temp file for "editor modified" (initially same as base)
                    // Make filePath2 for "clipboard"
                    // Tool might modify the "editor modified" temp file.
                    baseFilePath = tempFile1Path; // Original editor content
                    tempFile1Path = path.join(tempDir, `vscode-merge-${timestamp}-editor-modified${originalFileExt || '.tmp'}`);
                    await fs.writeFile(tempFile1Path, activeFileContent); // This will be "mine" and potentially modified
                    // tempFile2Path remains clipboard ("theirs")
                    // outputFilePath will be what we read from, often one of the inputs if modified in place.
                }
            }


            // Argument substitution
            let argString = toolArgumentsTemplate;
            argString = argString.replace(/{filePath1}/g, tempFile1Path);
            argString = argString.replace(/{filePath2}/g, tempFile2Path);
            if (useThreeWay && baseFilePath) {
                 argString = argString.replace(/{baseFilePath}/g, baseFilePath);
            }
            argString = argString.replace(/{outputFilePath}/g, outputFilePath);

            // Determine which file to monitor for changes based on common tool behaviors.
            // Rider: `merge local remote base output` -> output is `output`
            // BC: `BCompare.exe left right /savetarget=left_or_right_or_output` -> output is specified
            // Meld: Modifies one of the input files typically.
            // If toolArguments has /output= or similar, we assume outputFilePath is written to.
            // If not, some tools might modify filePath1 (editor's copy) or filePath2 (clipboard's copy).
            // For simplicity, we assume the user configures toolArguments to save to outputFilePath if the tool supports it.
            // Otherwise, we will have to guess or let the user configure which input is the target.
            // A more robust solution: check mtime of tempFile1Path and outputFilePath after tool exits.

            // Simple approach: If outputFilePath placeholder was in args, we expect that file.
            // If not, we'll assume the tool modifies tempFile1Path (the editor's temporary copy).
            if (!toolArgumentsTemplate.includes("{outputFilePath}")) {
                finalOutputToRead = tempFile1Path; // Assume tool modifies the 'editor' file in-place
            }


            // Split arguments correctly, handling spaces in paths if not already quoted by template
            // A simple split by space might fail if paths have spaces and aren't quoted in the template.
            // However, execFile takes arguments as an array, which is safer.
            // We'll assume the user's template correctly quotes paths if necessary, or the tool handles unquoted paths.
            // For `execFile`, it's better to pass arguments as an array.
            // A simplistic way to split if the template is space-separated:
            // actualToolArguments = argString.split(' ');
            // A more robust way for user-provided templates is hard.
            // Let's assume the user crafts the template carefully. For `execFile`, it's best if toolArguments is structured.
            // Alternative: `externalMerge.toolArgumentArray`: ["{filePath1}", "{filePath2}"]
            // For now, we will pass the processed argString as a single argument to shell, or try to split it.
            // Using shell: true can simplify this but has security implications. Best to avoid.

            // To properly use execFile without shell: true, arguments need to be an array.
            // This requires parsing the toolArgumentsTemplate intelligently.
            // Quick and dirty for now (less robust if paths have spaces and template doesn't quote):
            const regex = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
            actualToolArguments = [];
            let match;
            while (match = regex.exec(argString)) {
                actualToolArguments.push(match[1] || match[2] || match[0]);
            }


            vscode.window.showInformationMessage(`Launching external merge tool: ${toolPath} ${actualToolArguments.join(' ')}`);

            const child = execFile(toolPath, actualToolArguments, async (error, stdout, stderr) => {
                if (error && error.code !== 0) { // Some tools exit with non-zero even on success/cancel
                    // Check for specific error codes if known for the tool (e.g., cancel vs actual error)
                    // For now, show error but proceed to check for merged file.
                    vscode.window.showWarningMessage(`External tool exited with code ${error.code}. Stderr: ${stderr}`);
                    console.error(`External tool error: ${error.message}`);
                    console.error(`Stderr: ${stderr}`);
                    if (stdout) console.log(`Stdout: ${stdout}`);
                } else {
                    if (stdout) console.log(`External tool stdout: ${stdout}`);
                    if (stderr) console.warn(`External tool stderr: ${stderr}`); // Some tools use stderr for info
                    vscode.window.showInformationMessage('External merge tool finished.');
                }

                // After tool closes, try to read the output file
                try {
                    // Check if the original file was modified by looking at its mtime BEFORE and AFTER.
                    // This is more complex. For now, rely on finalOutputToRead.
                    const mergedContent = await fs.readFile(finalOutputToRead, 'utf-8');

                    // Replace active editor content only if it changed
                    if (mergedContent !== activeFileContent) {
                        const edit = new vscode.WorkspaceEdit();
                        const fullRange = new vscode.Range(
                            document.positionAt(0),
                            document.positionAt(activeFileContent.length)
                        );
                        edit.replace(document.uri, fullRange, mergedContent);
                        await vscode.workspace.applyEdit(edit);
                        vscode.window.showInformationMessage('Merge applied to the active editor.');
                    } else {
                        vscode.window.showInformationMessage('No changes applied from merge tool (content is the same or tool saved elsewhere).');
                    }

                } catch (readError) {
                    vscode.window.showErrorMessage(`Failed to read merge result from ${finalOutputToRead}. Was the file saved by the merge tool?`);
                    console.error(readError);
                } finally {
                    // Clean up temporary files
                    if (baseFilePath) await fs.unlink(baseFilePath).catch(e => console.error("Failed to delete base temp file:", e));
                    if (tempFile1Path) await fs.unlink(tempFile1Path).catch(e => console.error("Failed to delete editor temp file:", e));
                    if (tempFile2Path) await fs.unlink(tempFile2Path).catch(e => console.error("Failed to delete clipboard temp file:", e));
                    if (toolArgumentsTemplate.includes("{outputFilePath}") && outputFilePath) { // Only delete distinct output if it was used
                        await fs.unlink(outputFilePath).catch(e => console.error("Failed to delete output temp file:", e));
                    }
                }
            });

            child.on('error', (spawnError) => {
                vscode.window.showErrorMessage(`Failed to start external merge tool: ${spawnError.message}`);
                console.error("Spawn error:", spawnError);
                 // Clean up temporary files
                if (baseFilePath) fs.unlink(baseFilePath).catch(e => console.error("Failed to delete base temp file:", e));
                if (tempFile1Path) fs.unlink(tempFile1Path).catch(e => console.error("Failed to delete editor temp file:", e));
                if (tempFile2Path) fs.unlink(tempFile2Path).catch(e => console.error("Failed to delete clipboard temp file:", e));
                if (toolArgumentsTemplate.includes("{outputFilePath}") && outputFilePath) {
                    fs.unlink(outputFilePath).catch(e => console.error("Failed to delete output temp file:", e));
                }
            });


        } catch (err: any) {
            vscode.window.showErrorMessage(`Error during merge process: ${err.message}`);
            console.error(err);
            // Ensure cleanup on unexpected errors
            if (baseFilePath && await fs.stat(baseFilePath).catch(()=>null)) await fs.unlink(baseFilePath).catch(e => console.error("Cleanup: Failed to delete base temp file:", e));
            if (tempFile1Path && await fs.stat(tempFile1Path).catch(()=>null)) await fs.unlink(tempFile1Path).catch(e => console.error("Cleanup: Failed to delete editor temp file:", e));
            if (tempFile2Path && await fs.stat(tempFile2Path).catch(()=>null)) await fs.unlink(tempFile2Path).catch(e => console.error("Cleanup: Failed to delete clipboard temp file:", e));
            if (toolArgumentsTemplate && toolArgumentsTemplate.includes("{outputFilePath}") && outputFilePath && await fs.stat(outputFilePath).catch(()=>null)) {
                await fs.unlink(outputFilePath).catch(e => console.error("Cleanup: Failed to delete output temp file:", e));
            }
        }
    });

    context.subscriptions.push(disposable);
}

export function deactivate() {}