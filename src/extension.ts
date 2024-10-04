/**
 * TODO: Should move this to README or ROADMAP
 * [ ] Show relative paths whenever possible
 *
 * Feature options:
 * [ ] Buffer of open files / show currently open files / always show at bottom => workspace.textDocuments is a bit curious / borked
 */

import assert from "node:assert";
import { execFileSync, execSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFile,
	readFileSync,
	rmSync,
	watch,
	writeFileSync,
} from "node:fs";
import { platform, tmpdir } from "node:os";
import { join, sep } from "node:path";
import * as vscode from "vscode";
import { workspace } from "vscode";

import { CFG, PathOrigin } from "./config";
import { Logger } from "./logger";
import { getIgnoreGlobs, getIgnoreString } from "./utils";

const logger = new Logger();

interface PackageJson {
	name: string;
	contributes: {
		commands: Array<{
			command: string;
		}>;
	};
}

// Let's keep it DRY and load the package here so we can reuse some data from it
let PACKAGE: PackageJson;
// Reference to the terminal we use
let term: vscode.Terminal;
let previousActiveTerminal: vscode.Terminal | null;
let isExtensionChangedTerminal = false;

//
// Define the commands we expose. URIs are populated upon extension activation
// because only then we'll know the actual paths.
//
interface Command {
	script: string;
	uri: vscode.Uri | undefined;
	preRunCallback: undefined | (() => boolean | Promise<boolean>);
	postRunCallback: undefined | (() => void);
	isCustomTask?: boolean;
}
const commands: { [key: string]: Command } = {
	findFiles: {
		script: "find_files",
		uri: undefined,
		preRunCallback: undefined,
		postRunCallback: undefined,
	},
	findFilesWithType: {
		script: "find_files",
		uri: undefined,
		preRunCallback: selectTypeFilter,
		postRunCallback: () => {
			CFG.useTypeFilter = false;
		},
	},
	findWithinFiles: {
		script: "find_within_files",
		uri: undefined,
		preRunCallback: undefined,
		postRunCallback: undefined,
	},
	findWithinFilesWithType: {
		script: "find_within_files",
		uri: undefined,
		preRunCallback: selectTypeFilter,
		postRunCallback: () => {
			CFG.useTypeFilter = false;
		},
	},
	listSearchLocations: {
		script: "list_search_locations",
		uri: undefined,
		preRunCallback: writePathOriginsFile,
		postRunCallback: undefined,
	},
	flightCheck: {
		script: "flight_check",
		uri: undefined,
		preRunCallback: undefined,
		postRunCallback: undefined,
	},
	resumeSearch: {
		script: "resume_search", // Dummy. We will set the uri from the last-run script. But we will use this value to check whether we are resuming.
		uri: undefined,
		preRunCallback: undefined,
		postRunCallback: undefined,
	},
	pickFileFromGitStatus: {
		script: "pick_file_from_git_status",
		uri: undefined,
		preRunCallback: undefined,
		postRunCallback: undefined,
	},
	findTodoFixme: {
		script: "find_todo_fixme",
		uri: undefined,
		preRunCallback: undefined,
		postRunCallback: undefined,
	},
	runCustomTask: {
		script: "run_custom_task",
		uri: undefined,
		preRunCallback: chooseCustomTask,
		postRunCallback: undefined,
		isCustomTask: true,
	},
	findFilesJs: {
		script: "find_files_js",
		uri: undefined,
		preRunCallback: undefined,
		postRunCallback: undefined,
	},
};

function getTypeOptions() {
	const result = execSync("rg --type-list").toString();
	return result
		.split("\n")
		.map((line) => {
			const [typeStr, typeInfo] = line.split(":");
			return new FileTypeOption(
				typeStr,
				typeInfo,
				CFG.findWithinFilesFilter.has(typeStr),
			);
		})
		.filter((x) => x.label.trim().length !== 0);
}

class FileTypeOption implements vscode.QuickPickItem {
	label: string;
	description: string;
	picked: boolean;

	constructor(typeStr: string, types: string, picked = false) {
		this.label = typeStr;
		this.description = types;
		this.picked = picked;
	}
}

async function selectTypeFilter() {
	const opts = getTypeOptions();
	return await new Promise<boolean>((resolve, _) => {
		const qp = vscode.window.createQuickPick();
		let hasResolved = false; // I don't understand why this is necessary... Seems like I can resolve twice?

		qp.items = opts;
		qp.title = `Type one or more type identifiers below and press Enter,
        OR select the types you want below. Example: typing "py cpp<Enter>"
        (without ticking any boxes will search within python and C++ files.
        Typing nothing and selecting those corresponding entries will do the
        same. Typing "X" (capital x) clears all selections.`;
		qp.placeholder = "enter one or more types...";
		qp.canSelectMany = true;
		// https://github.com/microsoft/vscode/issues/103084
		// https://github.com/microsoft/vscode/issues/119834
		qp.selectedItems = qp.items.filter((x) =>
			CFG.findWithinFilesFilter.has(x.label),
		);
		qp.value = [...CFG.findWithinFilesFilter.keys()].reduce(
			(x, y) => `${x} ${y}`,
			"",
		);
		qp.matchOnDescription = true;
		qp.show();
		qp.onDidChangeValue(() => {
			if (qp.value.length > 0 && qp.value[qp.value.length - 1] === "X") {
				// This is where we're fighting with VS Code a little bit.
				// When you don't reassign the items, the "X" will still be filtering the results,
				// which we obviously don't want. Currently (6/2021), this works as expected.
				qp.value = "";
				qp.selectedItems = [];
				qp.items = [...qp.items]; // Create a new array to trigger update
			}
		});
		qp.onDidAccept(() => {
			CFG.useTypeFilter = true;
			logger.info("Using type filter", qp.activeItems);
			CFG.findWithinFilesFilter.clear(); // reset
			if (qp.selectedItems.length === 0) {
				// If there are no active items, use the string that was entered.
				// split on empty string yields an array with empty string, catch that
				const types = qp.value === "" ? [] : qp.value.trim().split(/\s+/);
				for (const x of types) {
					CFG.findWithinFilesFilter.add(x);
				}
			} else {
				// If there are active items, use those.
				for (const x of qp.selectedItems) {
					CFG.findWithinFilesFilter.add(x.label);
				}
			}
			hasResolved = true;
			resolve(true);
			qp.dispose();
		});
		qp.onDidHide(() => {
			qp.dispose();
			if (!hasResolved) {
				resolve(false);
			}
		});
	});
}

/** Ensure that whatever command we expose in package.json actually exists */
function checkExposedFunctions() {
	for (const x of PACKAGE.contributes.commands) {
		const fName = x.command.substring(PACKAGE.name.length + ".".length);
		assert(fName in commands);
	}
}

/** We need the extension context to get paths to our scripts. We do that here. */
function setupConfig(context: vscode.ExtensionContext) {
	CFG.extensionName = PACKAGE.name;
	assert(CFG.extensionName);
	const localScript = (x: string) =>
		vscode.Uri.file(
			join(context.extensionPath, x) +
				(platform() === "win32" ? ".ps1" : ".sh"),
		);
	commands.findFiles.uri = localScript(commands.findFiles.script);
	commands.findFilesWithType.uri = localScript(commands.findFiles.script);
	commands.findWithinFiles.uri = localScript(commands.findWithinFiles.script);
	commands.findWithinFilesWithType.uri = localScript(
		commands.findWithinFiles.script,
	);
	commands.listSearchLocations.uri = localScript(
		commands.listSearchLocations.script,
	);
	commands.flightCheck.uri = localScript(commands.flightCheck.script);
	commands.pickFileFromGitStatus.uri = localScript(
		commands.pickFileFromGitStatus.script,
	);
	commands.findTodoFixme.uri = localScript(commands.findTodoFixme.script);
}

/** Register the commands we defined with VS Code so users have access to them */
function registerCommands() {
	Object.keys(commands).map((k) => {
		vscode.commands.registerCommand(`${CFG.extensionName}.${k}`, () => {
			executeTerminalCommand(k);
		});
	});
}

/** Entry point called by VS Code */
export function activate(context: vscode.ExtensionContext) {
	CFG.extensionPath = context.extensionPath;
	const local = (x: string) => vscode.Uri.file(join(CFG.extensionPath, x));

	// Load our package.json
	PACKAGE = JSON.parse(
		readFileSync(local("package.json").fsPath, "utf-8"),
	) as PackageJson;
	setupConfig(context);
	checkExposedFunctions();

	handleWorkspaceSettingsChanges();
	handleWorkspaceFoldersChanges();

	registerCommands();
	reinitialize();
}

/* Called when extension is deactivated by VS Code */
export function deactivate() {
	term?.dispose();
	rmSync(CFG.canaryFile, { force: true });
	rmSync(CFG.selectionFile, { force: true });
	if (existsSync(CFG.lastQueryFile)) {
		rmSync(CFG.lastQueryFile, { force: true });
	}
	if (existsSync(CFG.lastPosFile)) {
		rmSync(CFG.lastPosFile, { force: true });
	}
}

/** Map settings from the user-configurable settings to our internal data structure */
function updateConfigWithUserSettings() {
	function getCFG<T>(key: string) {
		const userCfg = vscode.workspace.getConfiguration();
		const ret = userCfg.get<T>(`${CFG.extensionName}.${key}`);
		assert(ret !== undefined);
		return ret;
	}

	CFG.disableStartupChecks = getCFG("advanced.disableStartupChecks");
	CFG.useEditorSelectionAsQuery = getCFG("advanced.useEditorSelectionAsQuery");
	CFG.useWorkspaceSearchExcludes = getCFG("general.useWorkspaceSearchExcludes");
	CFG.useGitIgnoreExcludes = getCFG("general.useGitIgnoreExcludes");
	CFG.additionalSearchLocations = getCFG("general.additionalSearchLocations");
	CFG.additionalSearchLocationsWhen = getCFG(
		"general.additionalSearchLocationsWhen",
	);
	CFG.searchCurrentWorkingDirectory = getCFG(
		"general.searchCurrentWorkingDirectory",
	);
	CFG.searchWorkspaceFolders = getCFG("general.searchWorkspaceFolders");
	CFG.hideTerminalAfterSuccess = getCFG("general.hideTerminalAfterSuccess");
	CFG.hideTerminalAfterFail = getCFG("general.hideTerminalAfterFail");
	CFG.clearTerminalAfterUse = getCFG("general.clearTerminalAfterUse");
	CFG.killTerminalAfterUse = getCFG("general.killTerminalAfterUse");
	CFG.showMaximizedTerminal = getCFG("general.showMaximizedTerminal");
	CFG.batTheme = getCFG("general.batTheme");
	CFG.openFileInPreviewEditor = getCFG("general.openFileInPreviewEditor");
	CFG.findFilesPreviewEnabled = getCFG("findFiles.showPreview");
	CFG.findFilesPreviewCommand = getCFG("findFiles.previewCommand");
	CFG.findFilesPreviewWindowConfig = getCFG("findFiles.previewWindowConfig");
	CFG.findWithinFilesPreviewEnabled = getCFG("findWithinFiles.showPreview");
	CFG.findWithinFilesPreviewCommand = getCFG("findWithinFiles.previewCommand");
	CFG.findWithinFilesPreviewWindowConfig = getCFG(
		"findWithinFiles.previewWindowConfig",
	);
	CFG.fuzzRipgrepQuery = getCFG("findWithinFiles.fuzzRipgrepQuery");
	CFG.restoreFocusTerminal = getCFG("general.restoreFocusTerminal");
	CFG.useTerminalInEditor = getCFG("general.useTerminalInEditor");
	CFG.shellPathForTerminal = getCFG("general.shellPathForTerminal");
	CFG.findTodoFixmeSearchPattern = getCFG("findTodoFixme.searchPattern");
	CFG.customTasks = getCFG("customTasks");
}

function collectSearchLocations() {
	const locations: string[] = [];
	// searchPathsOrigins is for diagnostics only
	CFG.searchPathsOrigins = {};
	const setOrUpdateOrigin = (path: string, origin: PathOrigin) => {
		if (CFG.searchPathsOrigins[path] === undefined) {
			CFG.searchPathsOrigins[path] = origin;
		} else {
			CFG.searchPathsOrigins[path] |= origin;
		}
	};
	// cwd
	const addCwd = () => {
		const cwd = process.cwd();
		locations.push(cwd);
		setOrUpdateOrigin(cwd, PathOrigin.cwd);
	};
	switch (CFG.searchCurrentWorkingDirectory) {
		case "always":
			addCwd();
			break;
		case "never":
			break;
		case "noWorkspaceOnly":
			if (vscode.workspace.workspaceFolders === undefined) {
				addCwd();
			}
			break;
		default:
			assert(false, "Unhandled case");
	}

	// additional search locations from extension settings
	const addSearchLocationsFromSettings = () => {
		locations.push(...CFG.additionalSearchLocations);
		for (const x of CFG.additionalSearchLocations) {
			setOrUpdateOrigin(x, PathOrigin.settings);
		}
	};
	switch (CFG.additionalSearchLocationsWhen) {
		case "always":
			addSearchLocationsFromSettings();
			break;
		case "never":
			break;
		case "noWorkspaceOnly":
			if (vscode.workspace.workspaceFolders === undefined) {
				addSearchLocationsFromSettings();
			}
			break;
		default:
			assert(false, "Unhandled case");
	}

	// add the workspace folders
	if (
		CFG.searchWorkspaceFolders &&
		vscode.workspace.workspaceFolders !== undefined
	) {
		const dirs = vscode.workspace.workspaceFolders.map((x) => {
			const uri = decodeURIComponent(x.uri.toString());
			if (uri.substring(0, 7) === "file://") {
				if (platform() === "win32") {
					return uri.substring(8).replace(/\//g, "\\").replace(/%3A/g, ":");
				}
				return uri.substring(7);
			}
			vscode.window.showErrorMessage(
				"Non-file:// uri's not currently supported...",
			);
			logger.error("Non-file:// uri's not currently supported...");
			return "";
		});
		locations.push(...dirs);
		for (const x of dirs) {
			setOrUpdateOrigin(x, PathOrigin.workspace);
		}
	}

	return locations;
}

/** Produce a human-readable string explaining where the search paths come from */
function explainSearchLocations(useColor = false) {
	const listDirs = (which: PathOrigin) => {
		let str = "";
		for (const [k, v] of Object.entries(CFG.searchPathsOrigins)) {
			if ((v & which) !== 0) {
				str += `- ${k}\n`;
			}
		}
		if (str.length === 0) {
			str += "- <none>\n";
		}
		return str;
	};

	const maybeBlue = (s: string) => {
		return useColor ? `\\033[36m${s}\\033[0m` : s;
	};

	let ret = "";
	ret += maybeBlue("Paths added because they're the working directory:\n");
	ret += listDirs(PathOrigin.cwd);
	ret += maybeBlue("Paths added because they're defined in the workspace:\n");
	ret += listDirs(PathOrigin.workspace);
	ret += maybeBlue(
		"Paths added because they're the specified in the settings:\n",
	);
	ret += listDirs(PathOrigin.settings);

	return ret;
}

function writePathOriginsFile() {
	writeFileSync(
		join(CFG.tempDir, "paths_explain"),
		explainSearchLocations(platform() !== "win32"),
	);
	return true;
}

function handleWorkspaceFoldersChanges() {
	CFG.searchPaths = collectSearchLocations();

	// Also re-update when anything changes
	vscode.workspace.onDidChangeWorkspaceFolders((event) => {
		logger.info("workspace folders changed: ", event);
		CFG.searchPaths = collectSearchLocations();
	});
}

function handleWorkspaceSettingsChanges() {
	updateConfigWithUserSettings();

	// Also re-update when anything changes
	vscode.workspace.onDidChangeConfiguration((_) => {
		updateConfigWithUserSettings();
		// This may also have affected our search paths
		CFG.searchPaths = collectSearchLocations();
		// We need to update the env vars in the terminal
		reinitialize();
	});
}

/** Check seat belts are on. Also, check terminal commands are on PATH */
function doFlightCheck(): boolean {
	const parseKeyValue = (line: string) => {
		return line.split(": ", 2);
	};

	if (!commands.flightCheck || !commands.flightCheck.uri) {
		vscode.window.showErrorMessage(
			"Failed to find flight check script. This is a bug. Please report it.",
		);
		logger.error(
			`Failed to find flight check script at ${commands.flightCheck.uri?.fsPath}. This is a bug. Please report it.`,
		);
		return false;
	}

	try {
		let errStr = "";
		const kvs: Record<string, unknown> = {};
		let out = "";
		if (platform() === "win32") {
			out = execFileSync(
				"powershell.exe",
				[
					"-ExecutionPolicy",
					"Bypass",
					"-File",
					`"${commands.flightCheck.uri.fsPath}"`,
				],
				{ shell: true },
			).toString("utf-8");
		} else {
			out = execFileSync(commands.flightCheck.uri.fsPath, {
				shell: true,
			}).toString("utf-8");
		}
		out.split("\n").map((x) => {
			const maybeKV = parseKeyValue(x);
			if (maybeKV.length === 2) {
				kvs[maybeKV[0]] = maybeKV[1];
			}
		});
		if (kvs.bat === undefined || kvs.bat === "not installed") {
			errStr += "bat not found on your PATH. ";
		}
		if (kvs.fzf === undefined || kvs.fzf === "not installed") {
			errStr += "fzf not found on your PATH. ";
		}
		if (kvs.rg === undefined || kvs.rg === "not installed") {
			errStr += "rg not found on your PATH. ";
		}
		if (
			platform() !== "win32" &&
			(kvs.sed === undefined || kvs.sed === "not installed")
		) {
			errStr += "sed not found on your PATH. ";
		}
		if (errStr !== "") {
			vscode.window.showErrorMessage(
				`Failed to activate plugin! Make sure you have the required command line tools installed as outlined in the README. ${errStr}`,
			);
			logger.error(`Failed to activate plugin! ${errStr}`);
		}

		return errStr === "";
	} catch (error) {
		vscode.window.showErrorMessage(
			`Failed to run checks before starting extension. Maybe this is helpful: ${error}`,
		);
		return false;
	}
}

/**
 * All the logic that's the same between starting the plugin and re-starting
 * after user settings change
 */
function reinitialize() {
	term?.dispose();
	updateConfigWithUserSettings();
	logger.info("Plugin initialized with key settings:", {
		extensionName: CFG.extensionName,
		searchPaths: CFG.searchPaths,
		tempDir: CFG.tempDir,
	});
	if (!CFG.flightCheckPassed && !CFG.disableStartupChecks) {
		CFG.flightCheckPassed = doFlightCheck();
	}

	if (!CFG.flightCheckPassed && !CFG.disableStartupChecks) {
		return false;
	}

	//
	// Set up a file watcher. Its contents tell us what files the user selected.
	// It also means the command was completed so we can do stuff like
	// optionally hiding the terminal.
	//
	CFG.tempDir = mkdtempSync(`${tmpdir()}${sep}${CFG.extensionName}-`);
	CFG.canaryFile = join(CFG.tempDir, "snitch");
	CFG.selectionFile = join(CFG.tempDir, "selection");
	CFG.lastQueryFile = join(CFG.tempDir, "last_query");
	CFG.lastPosFile = join(CFG.tempDir, "last_position");
	writeFileSync(CFG.canaryFile, "");
	watch(CFG.canaryFile, (eventType) => {
		if (eventType === "change") {
			handleCanaryFileChange();
		} else if (eventType === "rename") {
			logger.error("Canary file was renamed! Please reload.");
			vscode.window.showErrorMessage(
				`Issue detected with extension ${CFG.extensionName}. You may have to reload it.`,
			);
		}
	});
	return true;
}

/** Interpreting the terminal output and turning them into a vscode command */
function openFiles(data: string) {
	const filePaths = data.split("\n").filter((s) => s !== "");
	if (filePaths.length === 0) return;

	for (const p of filePaths) {
		let [file, lineTmp, charTmp] = p.split(":", 3);
		if (platform() === "win32") {
			const re =
				/^\s*(?<file>([a-zA-Z][:])?[^:]+)([:](?<lineTmp>\d+))?\s*([:](?<charTmp>\d+))?.*/;
			const v = p.match(re);
			if (v?.groups) {
				file = v.groups.file;
				lineTmp = v.groups.lineTmp;
				charTmp = v.groups.charTmp;
			} else {
				vscode.window.showWarningMessage(
					`Did not match anything in filename: [${p}] could not open file!`,
				);
				continue;
			}
		}
		file = file.trim();
		let selection = undefined;
		if (lineTmp !== undefined) {
			let char = 0;
			if (charTmp !== undefined) {
				char = Number.parseInt(charTmp) - 1; // 1 based in rg, 0 based in VS Code
			}
			const line = Number.parseInt(lineTmp) - 1; // 1 based in rg, 0 based in VS Code
			if (line >= 0 && char >= 0) {
				selection = new vscode.Range(line, char, line, char);
			}
		}
		vscode.window.showTextDocument(vscode.Uri.file(file), {
			preview: CFG.openFileInPreviewEditor,
			selection: selection,
		});
	}
}

/** Logic of what to do when the user completed a command invocation on the terminal */
function handleCanaryFileChange() {
	if (CFG.clearTerminalAfterUse) {
		term?.sendText("clear");
	}

	if (CFG.killTerminalAfterUse) {
		// Some folks like having a constant terminal open. This will kill ours such that VS Code will
		// switch back to theirs. We don't have more control over the terminal so this is the best we
		// can do. This is not the default because creating a new terminal is sometimes expensive when
		// people use e.g. powerline or other fancy PS1 stuff.
		//
		// We set a timeout here to address #56. Don't have a good hypothesis as to why this works but
		// it seems to fix the issue consistently.
		setTimeout(() => term.dispose(), 100);
	}

	readFile(CFG.canaryFile, { encoding: "utf-8" }, (err, data) => {
		if (err) {
			// We shouldn't really end up here. Maybe leave the terminal around in this case...
			vscode.window.showWarningMessage(
				`An error occurred while reading the canary file: ${err.message}`,
			);
			logger.warn(
				`An error occurred while reading the canary file: ${err.message}`,
			);
			logger.warn(
				"Something went wrong but we don't know what... Did you clean out your /tmp folder?",
			);
		} else {
			const commandWasSuccess = data.length > 0 && data[0] !== "1";

			// open the file(s)
			if (commandWasSuccess) {
				openFiles(data);
			}

			if (CFG.restoreFocusTerminal && previousActiveTerminal) {
				handleTerminalFocusRestore(commandWasSuccess);
				return;
			}

			if (commandWasSuccess && CFG.hideTerminalAfterSuccess) {
				term.hide();
			} else if (!commandWasSuccess && CFG.hideTerminalAfterFail) {
				term.hide();
			} else {
				// Don't hide the terminal and make clippy angry
			}
		}
	});
}

function handleTerminalFocusRestore(commandWasSuccess: boolean) {
	const shouldHideTerminal =
		(commandWasSuccess && CFG.hideTerminalAfterSuccess) ||
		(!commandWasSuccess && CFG.hideTerminalAfterFail);

	if (shouldHideTerminal) {
		const disposable = vscode.window.onDidChangeActiveTerminal(
			(activeTerminal) => {
				if (
					isExtensionChangedTerminal &&
					activeTerminal === previousActiveTerminal
				) {
					previousActiveTerminal?.hide();
					previousActiveTerminal = null;
					isExtensionChangedTerminal = false;
					disposable.dispose();
				}
			},
		);
	}

	isExtensionChangedTerminal = true;
	previousActiveTerminal?.show();
}

function createTerminal() {
	const terminalOptions: vscode.TerminalOptions = {
		name: "F️indItFaster",
		location: CFG.useTerminalInEditor
			? vscode.TerminalLocation.Editor
			: vscode.TerminalLocation.Panel,
		hideFromUser: !CFG.useTerminalInEditor, // works only for terminal panel, not editor stage
		env: {
			FIND_IT_FASTER_ACTIVE: "1",
			HISTCONTROL: "ignoreboth", // bash
			// HISTORY_IGNORE: '*',        // zsh
			EXTENSION_PATH: CFG.extensionPath,
			FIND_FILES_PREVIEW_ENABLED: CFG.findFilesPreviewEnabled ? "1" : "0",
			FIND_FILES_PREVIEW_COMMAND: CFG.findFilesPreviewCommand,
			FIND_FILES_PREVIEW_WINDOW_CONFIG: CFG.findFilesPreviewWindowConfig,
			FIND_WITHIN_FILES_PREVIEW_ENABLED: CFG.findWithinFilesPreviewEnabled
				? "1"
				: "0",
			FIND_WITHIN_FILES_PREVIEW_COMMAND: CFG.findWithinFilesPreviewCommand,
			FIND_WITHIN_FILES_PREVIEW_WINDOW_CONFIG:
				CFG.findWithinFilesPreviewWindowConfig,
			USE_GITIGNORE: CFG.useGitIgnoreExcludes ? "1" : "0",
			GLOBS: CFG.useWorkspaceSearchExcludes ? getIgnoreString() : "",
			CANARY_FILE: CFG.canaryFile,
			SELECTION_FILE: CFG.selectionFile,
			LAST_QUERY_FILE: CFG.lastQueryFile,
			LAST_POS_FILE: CFG.lastPosFile,
			EXPLAIN_FILE: join(CFG.tempDir, "paths_explain"),
			BAT_THEME: CFG.batTheme,
			FUZZ_RG_QUERY: CFG.fuzzRipgrepQuery ? "1" : "0",
			FIND_TODO_FIXME_SEARCH_PATTERN: CFG.findTodoFixmeSearchPattern,
		},
	};
	// Use provided terminal from settings, otherwise use default terminal profile
	if (CFG.shellPathForTerminal !== "") {
		terminalOptions.shellPath = CFG.shellPathForTerminal;
	}

	term = vscode.window.createTerminal(terminalOptions);
}

function getWorkspaceFoldersAsString() {
	// For bash invocation. Need to wrap in quotes so spaces within paths don't
	// split the path into two strings.
	return CFG.searchPaths.reduce((x, y) => `${x} '${y}'`, "");
}

function getCommandString(
	cmd: Command,
	withArgs = true,
	withTextSelection = true,
) {
	assert(cmd.uri);
	let result = "";
	const cmdPath = cmd.uri.fsPath;

	if (
		cmd.script === "pick_file_from_git_status" ||
		cmd.script === "find_todo_fixme"
	) {
		// Always set HAS_SELECTION to 0 for these specific commands
		result += envVarToString("HAS_SELECTION", "0");
	} else if (CFG.useEditorSelectionAsQuery && withTextSelection) {
		const editor = vscode.window.activeTextEditor;
		if (editor) {
			const selection = editor.selection;
			if (!selection.isEmpty) {
				//
				// Fun story on text selection:
				// My first idea was to use an env var to capture the selection.
				// My first test was to use a selection that contained shell script...
				// This breaks. And fixing it is not easy. See https://unix.stackexchange.com/a/600214/128132.
				// So perhaps we should write this to file, and see if we can get bash to interpret this as a
				// string. We'll use an env var to indicate there is a selection so we don't need to read a
				// file in the general no-selection case, and we don't have to clear the file after having
				// used the selection.
				//
				const selectionText = editor.document.getText(selection);
				writeFileSync(CFG.selectionFile, selectionText);
				result += envVarToString("HAS_SELECTION", "1");
			} else {
				result += envVarToString("HAS_SELECTION", "0");
			}
		}
	}
	// useTypeFilter should only be try if we activated the corresponding command
	if (CFG.useTypeFilter && CFG.findWithinFilesFilter.size > 0) {
		result += envVarToString(
			"TYPE_FILTER",
			`'${[...CFG.findWithinFilesFilter].reduce((x, y) => `${x}:${y}`)}'`,
		);
	}
	if (cmd.script === "resume_search") {
		result += envVarToString("RESUME_SEARCH", "1");
	}
	result += cmdPath;
	if (withArgs) {
		const paths = getWorkspaceFoldersAsString();
		result += ` ${paths}`;
	}
	logger.info("Get command", result);
	return result;
}

async function executeTerminalCommand(cmd: string) {
	getIgnoreGlobs();
	if (!CFG.flightCheckPassed && !CFG.disableStartupChecks) {
		if (!reinitialize()) {
			return;
		}
	}

	if (cmd === "resumeSearch") {
		// Run the last-run command again
		if (platform() === "win32") {
			vscode.window.showErrorMessage(
				"Resume search is not implemented on Windows. Sorry! PRs welcome.",
			);
			logger.error(
				"Resume search is not implemented on Windows. Sorry! PRs welcome.",
			);
			return;
		}
		if (CFG.lastCommand === "") {
			vscode.window.showErrorMessage(
				"Cannot resume the last search because no search was run yet.",
			);
			logger.error(
				"Cannot resume the last search because no search was run yet.",
			);
			return;
		}
		commands.resumeSearch.uri = commands[CFG.lastCommand].uri;
		commands.resumeSearch.preRunCallback =
			commands[CFG.lastCommand].preRunCallback;
		commands.resumeSearch.postRunCallback =
			commands[CFG.lastCommand].postRunCallback;
	} else if (cmd.startsWith("find")) {
		// Keep track of last-run cmd, but we don't want to resume `listSearchLocations` etc
		CFG.lastCommand = cmd;
	} else if (cmd === "pickFileFromGitStatus") {
		// Keep track of last-run cmd
		CFG.lastCommand = cmd;
	}

	assert(cmd in commands);
	const cb = commands[cmd].preRunCallback;
	let cbResult = true;
	if (cb !== undefined) {
		cbResult = await cb();
	}

	if (cmd === "findFilesJs") {
		logger.info(`Executing ${cmd} command`);
		await executeCommand("findFiles");
		return;
	}

	if (cbResult === true && !commands[cmd].isCustomTask) {
		term.sendText(getCommandString(commands[cmd]));
		if (CFG.showMaximizedTerminal) {
			vscode.commands.executeCommand("workbench.action.toggleMaximizedPanel");
		}
		if (CFG.restoreFocusTerminal) {
			previousActiveTerminal = vscode.window.activeTerminal ?? null;
		}
		term.show();
		const postRunCallback = commands[cmd].postRunCallback;
		if (postRunCallback !== undefined) {
			postRunCallback();
		}
	}
}

function envVarToString(name: string, value: string) {
	// Note we add a space afterwards
	return platform() === "win32"
		? `$Env:${name}=${value}; `
		: `${name}=${value} `;
}

interface CustomTask {
	name: string;
	command: string;
}

async function executeCustomTask(task: CustomTask): Promise<void> {
	if (!term || term.exitStatus !== undefined) {
		createTerminal();
	}

	logger.info(`Executing custom task: ${task.command}`);
	term.sendText(task.command);
	term.show();
}

async function chooseCustomTask(): Promise<boolean> {
	const customTasks = CFG.customTasks;
	if (customTasks.length === 0) {
		vscode.window.showWarningMessage(
			"No custom tasks defined. Add some in the settings.",
		);
		return false;
	}

	const taskItems = customTasks.map((task) => ({
		label: task.name,
		description: task.command,
	}));

	const selectedTask = await vscode.window.showQuickPick(taskItems, {
		placeHolder: "Choose a custom task to run",
	});

	if (selectedTask) {
		const task = customTasks.find((t) => t.name === selectedTask.label);
		if (task) {
			try {
				await executeCustomTask(task);
				return true;
			} catch (error) {
				logger.error("Failed to execute custom task", error);
				return false;
			}
		}
	}

	return false;
}

async function executeCommand(name: string) {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders) {
		vscode.window.showErrorMessage("No workspace folder open");
		return;
	}

	const rootPath = workspaceFolders[0].uri.fsPath;

	// Create a new terminal if it doesn't exist
	if (!term || term.exitStatus !== undefined) {
		createTerminal();
	}

	// Get the path to the commands.js file
	const commandsJsPath = join(CFG.extensionPath, "out", "commands.js");

	// Construct the command to run
	logger.info(`Executing ${name} command`);
	const command = `node "${commandsJsPath}" "${name}" "${rootPath}"`;

	// Send the command to the terminal
	term.sendText(command);

	// Show the terminal
	term.show();

	// Set up a file watcher for the canary file
	const watcher = workspace.createFileSystemWatcher(CFG.canaryFile);
	watcher.onDidChange(() => {
		handleCanaryFileChange();
		watcher.dispose(); // Dispose the watcher after handling the change

		// Clear the terminal output after a short delay
		setTimeout(() => {
			if (term) {
				term.sendText("clear", true);
			}
		}, 100); // Adjust this delay if needed
	});
}
