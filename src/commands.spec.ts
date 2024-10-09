import * as childProcess from "node:child_process";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findFiles, liveGrep } from "./commands";

vi.mock("node:child_process");
vi.mock("node:fs");

describe("findFiles", () => {
	const cwd = process.cwd();
	const testDir = path.join(cwd, "src");

	beforeEach(() => {
		vi.resetAllMocks();
		vi.resetModules();
		vi.spyOn(process, "chdir").mockImplementation(() => {});
		process.chdir(testDir);
	});

	afterEach(() => {
		vi.clearAllMocks();
		process.chdir(cwd);
	});

	it("should find files successfully", async () => {
		const mockSpawn = vi.spyOn(childProcess, "spawn");

		// Mock rg process
		const mockRgStdout = {
			pipe: vi.fn(),
		};
		const mockRg = {
			stdout: mockRgStdout,
			on: vi.fn(),
		};

		// Mock fzf process
		const mockFzfStdout = {
			on: vi.fn().mockImplementation((event, callback) => {
				if (event === "data") {
					callback("commands.ts\nextension.ts");
				}
			}),
		};
		const mockFzf = {
			stdin: { end: vi.fn() },
			stdout: mockFzfStdout,
			on: vi.fn().mockImplementation((event, callback) => {
				if (event === "close") {
					callback(0);
				}
			}),
		};

		mockSpawn.mockImplementation((command) => {
			if (command === "rg")
				return mockRg as unknown as childProcess.ChildProcess;
			if (command === "fzf")
				return mockFzf as unknown as childProcess.ChildProcess;
			return {} as childProcess.ChildProcess;
		});

		const result = await findFiles([testDir]);

		expect(result).toEqual([
			path.join(testDir, "commands.ts"),
			path.join(testDir, "extension.ts"),
		]);
		expect(mockSpawn).toHaveBeenCalledTimes(2);
	});

	it("should handle single directory root", async () => {
		const mockSpawn = vi.spyOn(childProcess, "spawn");

		// Mock rg and fzf processes similar to the previous test
		const mockRgStdout = { pipe: vi.fn() };
		const mockRg = { stdout: mockRgStdout, on: vi.fn() };
		const mockFzfStdout = {
			on: vi.fn().mockImplementation((event, callback) => {
				if (event === "data") {
					callback("commands.ts\nextension.ts");
				}
			}),
		};
		const mockFzf = {
			stdin: { end: vi.fn() },
			stdout: mockFzfStdout,
			on: vi.fn().mockImplementation((event, callback) => {
				if (event === "close") {
					callback(0);
				}
			}),
		};

		mockSpawn.mockImplementation((command) => {
			if (command === "rg")
				return mockRg as unknown as childProcess.ChildProcess;
			if (command === "fzf")
				return mockFzf as unknown as childProcess.ChildProcess;
			return {} as childProcess.ChildProcess;
		});

		const result = await findFiles([testDir]);

		expect(result).toEqual([
			path.join(testDir, "commands.ts"),
			path.join(testDir, "extension.ts"),
		]);
		expect(process.chdir).toHaveBeenCalledWith(testDir);
	});

	it("should use gitignore by default", async () => {
		const mockSpawn = vi.spyOn(childProcess, "spawn");

		// Mock rg and fzf processes
		const mockRg = { stdout: { pipe: vi.fn() }, on: vi.fn() };
		const mockFzf = {
			stdin: { end: vi.fn() },
			stdout: { on: vi.fn() },
			on: vi.fn().mockImplementation((event, callback) => {
				if (event === "close") callback(0);
			}),
		};

		mockSpawn.mockImplementation((command) => {
			if (command === "rg")
				return mockRg as unknown as childProcess.ChildProcess;
			if (command === "fzf")
				return mockFzf as unknown as childProcess.ChildProcess;
			return {} as childProcess.ChildProcess;
		});

		await findFiles([testDir]);

		expect(mockSpawn).toHaveBeenCalledWith(
			"rg",
			expect.not.arrayContaining(["--no-ignore"]),
		);
	});

	it("should not use gitignore when USE_GITIGNORE is set to 0", async () => {
		process.env.USE_GITIGNORE = "0";
		const mockSpawn = vi.spyOn(childProcess, "spawn");

		// Mock rg and fzf processes
		const mockRg = { stdout: { pipe: vi.fn() }, on: vi.fn() };
		const mockFzf = {
			stdin: { end: vi.fn() },
			stdout: { on: vi.fn() },
			on: vi.fn().mockImplementation((event, callback) => {
				if (event === "close") callback(0);
			}),
		};

		mockSpawn.mockImplementation((command) => {
			if (command === "rg")
				return mockRg as unknown as childProcess.ChildProcess;
			if (command === "fzf")
				return mockFzf as unknown as childProcess.ChildProcess;
			return {} as childProcess.ChildProcess;
		});

		await findFiles([testDir]);

		expect(mockSpawn).toHaveBeenCalledWith(
			"rg",
			expect.arrayContaining(["--no-ignore"]),
		);
	});

	it("should handle file type filtering", async () => {
		process.env.TYPE_FILTER = "ts:js";
		const mockSpawn = vi.spyOn(childProcess, "spawn");

		// Mock rg and fzf processes
		const mockRg = { stdout: { pipe: vi.fn() }, on: vi.fn() };
		const mockFzf = {
			stdin: { end: vi.fn() },
			stdout: { on: vi.fn() },
			on: vi.fn().mockImplementation((event, callback) => {
				if (event === "close") callback(0);
			}),
		};

		mockSpawn.mockImplementation((command) => {
			if (command === "rg")
				return mockRg as unknown as childProcess.ChildProcess;
			if (command === "fzf")
				return mockFzf as unknown as childProcess.ChildProcess;
			return {} as childProcess.ChildProcess;
		});

		await findFiles([testDir]);

		expect(mockSpawn).toHaveBeenCalledWith(
			"rg",
			expect.arrayContaining(["--type", "ts", "--type", "js"]),
		);
	});

	it("should reject when fzf process exits with non-zero code", async () => {
		const mockSpawn = vi.spyOn(childProcess, "spawn");

		// Mock rg process
		const mockRg = { stdout: { pipe: vi.fn() }, on: vi.fn() };

		// Mock fzf process with non-zero exit code
		const mockFzf = {
			stdin: { end: vi.fn() },
			stdout: { on: vi.fn() },
			on: vi.fn().mockImplementation((event, callback) => {
				if (event === "close") {
					callback(1);
				}
			}),
		};

		mockSpawn.mockImplementation((command) => {
			if (command === "fzf")
				return mockFzf as unknown as childProcess.ChildProcess;
			return mockRg as unknown as childProcess.ChildProcess;
		});

		await expect(findFiles([testDir])).rejects.toThrow(
			"File selection canceled",
		);
	});
});

describe("liveGrep", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("should search within files successfully", async () => {
		const mockSpawn = vi.spyOn(childProcess, "spawn");
		const mockRg = {
			stdout: { pipe: vi.fn() },
			stderr: { pipe: vi.fn() },
			on: vi.fn(),
			kill: vi.fn(),
		};
		const mockFzf = {
			stdin: { end: vi.fn() },
			stdout: {
				on: vi.fn().mockImplementation((event, callback) => {
					if (event === "data") {
						callback(
							"file1.txt:10:5:matched line\nfile2.txt:20:3:another match",
						);
					}
				}),
			},
			on: vi.fn().mockImplementation((event, callback) => {
				if (event === "close") {
					callback(0);
				}
			}),
		};

		mockSpawn.mockImplementation((command) => {
			if (command === "rg")
				return mockRg as unknown as childProcess.ChildProcess;
			if (command === "fzf")
				return mockFzf as unknown as childProcess.ChildProcess;
			return {} as childProcess.ChildProcess;
		});

		const result = await liveGrep([process.cwd()], "");

		expect(result).toEqual([
			`${process.cwd()}/file1.txt:10:5`,
			`${process.cwd()}/file2.txt:20:3`,
		]);
		expect(mockSpawn).toHaveBeenCalledTimes(2);
	});

	it("should handle errors", async () => {
		const mockSpawn = vi.spyOn(childProcess, "spawn");
		mockSpawn.mockImplementation(() => {
			throw new Error("Command failed");
		});

		await expect(liveGrep([process.cwd()], "searchText")).rejects.toThrow(
			"Command failed",
		);
	});
});
