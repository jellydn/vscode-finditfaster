type WhenCondition = "always" | "never" | "noWorkspaceOnly";
export enum PathOrigin {
	cwd = 1 << 0,
	workspace = 1 << 1,
	settings = 1 << 2,
}

export interface CustomTask {
	name: string;
	command: string;
}

/** Global variable cesspool erm, I mean, Configuration Data Structure! It does the job for now. */
export interface Config {
	extensionName: string | undefined;
	searchPaths: string[];
	searchPathsOrigins: { [key: string]: PathOrigin };
	useEditorSelectionAsQuery: boolean;
	useGitIgnoreExcludes: boolean;
	useWorkspaceSearchExcludes: boolean;
	findFilesPreviewEnabled: boolean;
	findFilesPreviewCommand: string;
	findFilesPreviewWindowConfig: string;
	findWithinFilesPreviewEnabled: boolean;
	findWithinFilesPreviewCommand: string;
	findWithinFilesPreviewWindowConfig: string;
	findWithinFilesFilter: Set<string>;
	workspaceSettings: {
		folders: string[];
	};
	additionalSearchLocations: string[];
	additionalSearchLocationsWhen: WhenCondition;
	searchCurrentWorkingDirectory: WhenCondition;
	searchWorkspaceFolders: boolean;
	extensionPath: string;
	useTypeFilter: boolean;
	lastCommand: string;
	batTheme: string;
	openFileInPreviewEditor: boolean;
	fuzzRgQuery: boolean;
	findTodoFixmeSearchPattern: string;
	customTasks: CustomTask[];
	openCommand: string;
}

export const CFG: Config = {
	extensionName: undefined,
	searchPaths: [],
	searchPathsOrigins: {},
	useEditorSelectionAsQuery: true,
	useGitIgnoreExcludes: true,
	useWorkspaceSearchExcludes: true,
	findFilesPreviewEnabled: true,
	findFilesPreviewCommand: "",
	findFilesPreviewWindowConfig: "",
	findWithinFilesPreviewEnabled: true,
	findWithinFilesPreviewCommand: "",
	findWithinFilesPreviewWindowConfig: "",
	findWithinFilesFilter: new Set(),
	workspaceSettings: {
		folders: [],
	},
	additionalSearchLocations: [],
	additionalSearchLocationsWhen: "never",
	searchCurrentWorkingDirectory: "never",
	searchWorkspaceFolders: true,
	extensionPath: "",
	useTypeFilter: false,
	lastCommand: "",
	batTheme: "",
	openFileInPreviewEditor: false,
	fuzzRgQuery: false,
	findTodoFixmeSearchPattern: "(TODO|FIXME|HACK|FIX):\\s",
	customTasks: [
		{
			name: "zoxide",
			command: "code $(zoxide query --interactive)",
		},
	],
	openCommand: "code -g",
};
