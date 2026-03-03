import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Snippets } from "./types.js";

const GLOBAL_CONFIG = join(homedir(), ".pi", "agent", "prompt-snippets.json");

/** Load snippets from config files. Project-local overrides global. */
export function loadSnippets(cwd: string): Snippets {
	const projectConfig = join(cwd, ".pi", "prompt-snippets.json");
	let globalSnippets: Snippets = {};
	let projectSnippets: Snippets = {};

	// Load global snippets
	if (existsSync(GLOBAL_CONFIG)) {
		try {
			const content = readFileSync(GLOBAL_CONFIG, "utf-8");
			globalSnippets = JSON.parse(content);
		} catch (err) {
			console.error(`Failed to load global snippets from ${GLOBAL_CONFIG}: ${err}`);
		}
	}

	// Load project snippets
	if (existsSync(projectConfig)) {
		try {
			const content = readFileSync(projectConfig, "utf-8");
			projectSnippets = JSON.parse(content);
		} catch (err) {
			console.error(`Failed to load project snippets from ${projectConfig}: ${err}`);
		}
	}

	// Project overrides global
	return { ...globalSnippets, ...projectSnippets };
}

/** Save snippets to global config file */
export function saveSnippets(snippets: Snippets): void {
	try {
		writeFileSync(GLOBAL_CONFIG, JSON.stringify(snippets, null, 2), "utf-8");
	} catch (err) {
		throw new Error(`Failed to save snippets to ${GLOBAL_CONFIG}: ${err}`);
	}
}

/** Create a new snippet or update existing one */
export function addSnippet(snippets: Snippets, name: string, text: string): Snippets {
	return { ...snippets, [name]: text };
}

/** Delete a snippet by name */
export function deleteSnippet(snippets: Snippets, name: string): Snippets {
	const { [name]: _, ...rest } = snippets;
	return rest;
}

/** Get a single snippet by name */
export function getSnippet(snippets: Snippets, name: string): string | undefined {
	return snippets[name];
}

/** Check if a snippet exists */
export function hasSnippet(snippets: Snippets, name: string): boolean {
	return name in snippets;
}