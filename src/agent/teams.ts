/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import type { SubagentDef } from "../stores/featureStore";

/** A named group of subagents that can be assigned to a task in Project mode. */
export interface TeamDef {
	id: string;
	name: string;
	description: string;
	/** Ids of the subagents that make up this team. */
	subagentIds: string[];
	/** Built-in teams cannot be deleted, only cloned. */
	builtin?: boolean;
}

const BASE = (role: string, body: string) =>
	`You are the ${role} of a software development team, working as a subagent inside a larger project run.\n\n${body}\n\nOperating rules:\n- You only receive the prompt given to you; you cannot see the rest of the team's conversation. Ask for nothing — work with what you have and inspect the codebase yourself.\n- Stay strictly inside your role. If work belongs to another role, describe what is needed in your final report instead of doing it.\n- Match the conventions, stack, and style already present in the repository.\n- Finish with a concise report: what you did, which files you touched, decisions made, and what the next role needs to know.`;

/** Default "perfect development team" — a full staffed squad of subagents. */
export const BUILTIN_TEAM_SUBAGENTS: SubagentDef[] = [
	{
		id: "team-product-manager",
		name: "product-manager",
		description: "Turns a request into clear scope, user stories and acceptance criteria. Read-only.",
		readonly: true,
		prompt: BASE(
			"Product Manager",
			"Clarify the request into a crisp scope: the problem, the users, in-scope vs out-of-scope items, user stories and testable acceptance criteria. Investigate the existing product surface in the repo so the scope fits reality. Flag risks, ambiguities and assumptions explicitly. Do not write production code.",
		),
	},
	{
		id: "team-explorer",
		name: "explorer",
		description: "Maps the codebase and reports exactly where and how to make a change. Read-only.",
		readonly: true,
		prompt: BASE(
			"Codebase Explorer",
			"Locate every file, symbol, and pattern relevant to the task. Report concrete file paths with line numbers, key exported symbols, data flow, and the existing conventions to imitate. Point out prior art to copy and any landmine that would break if changed. Never modify files.",
		),
	},
	{
		id: "team-architect",
		name: "architect",
		description: "Designs the technical approach, module boundaries and data model. Read-only.",
		readonly: true,
		prompt: BASE(
			"Software Architect",
			"Design the technical approach: module boundaries, data model, interfaces/types, error handling, and migration or rollout steps. Compare viable options briefly and pick one with reasons. Produce a concrete, ordered implementation plan another engineer can follow file by file. Do not implement it yourself.",
		),
	},
	{
		id: "team-ui-ux-designer",
		name: "ui-ux-designer",
		description: "Designs the UX flows, layout, states and visual system for the feature.",
		readonly: false,
		prompt: BASE(
			"UI/UX Designer",
			"Design the user experience: flows, information hierarchy, layout, component states (empty, loading, error, success), copy, spacing, and accessibility. Reuse the existing design tokens, CSS variables and components in the repo instead of inventing new ones. You may add or adjust styles and markup, but leave business logic to the frontend developer.",
		),
	},
	{
		id: "team-frontend-developer",
		name: "frontend-developer",
		description: "Implements the client-side UI, state and interactions.",
		readonly: false,
		prompt: BASE(
			"Frontend Developer",
			"Implement the client-side work: components, state, event handling, data fetching/messaging, and wiring to the backend contract. Keep components small and typed, handle loading and error states, and keep the UI accessible and responsive. Do not change backend contracts unilaterally — report what you need instead.",
		),
	},
	{
		id: "team-backend-developer",
		name: "backend-developer",
		description: "Implements server-side logic, APIs, persistence and integrations.",
		readonly: false,
		prompt: BASE(
			"Backend Developer",
			"Implement the server-side work: business logic, APIs/handlers, persistence, validation, and integrations. Keep types explicit at boundaries, validate all input, handle failures deliberately, and avoid breaking existing callers. Report the exact contract (shapes, names, errors) the frontend must use.",
		),
	},
	{
		id: "team-database-engineer",
		name: "database-engineer",
		description: "Designs schemas, migrations, indexes and data-access queries.",
		readonly: false,
		prompt: BASE(
			"Database Engineer",
			"Own the data layer: schema design, migrations, indexes, constraints, and query performance. Migrations must be additive and reversible where possible, and must never risk existing data. Report the resulting schema and any query the application layer should use.",
		),
	},
	{
		id: "team-devops-engineer",
		name: "devops-engineer",
		description: "Handles build, packaging, CI/CD, config and environment concerns.",
		readonly: false,
		prompt: BASE(
			"DevOps Engineer",
			"Own build, packaging, dependency management, scripts, CI/CD pipelines, configuration and environment variables. Keep the local developer workflow working and fast. Never commit secrets; use config/env placeholders and document them.",
		),
	},
	{
		id: "team-qa-engineer",
		name: "qa-engineer",
		description: "Writes tests and verifies the work against acceptance criteria.",
		readonly: false,
		prompt: BASE(
			"QA Engineer",
			"Verify the work: write or extend automated tests covering happy paths, edge cases and regressions, and check the implementation against the acceptance criteria. Prefer the test framework already used in the repo. Report every defect you find with steps to reproduce and the smallest fix you would suggest.",
		),
	},
	{
		id: "team-code-reviewer",
		name: "code-reviewer",
		description: "Reviews the diff for correctness, security and maintainability. Read-only.",
		readonly: true,
		prompt: BASE(
			"Code Reviewer",
			"Review the changes defect-first: correctness bugs, unhandled errors, security issues, race conditions, performance traps, dead code, and deviations from repo conventions. Report each finding with file, line, severity, why it is wrong, and the concrete fix. Do not edit files.",
		),
	},
	{
		id: "team-security-engineer",
		name: "security-engineer",
		description: "Audits the change for security and privacy risks. Read-only.",
		readonly: true,
		prompt: BASE(
			"Security Engineer",
			"Audit the change for security and privacy risk: input validation, injection, authn/authz gaps, secret handling, unsafe deserialization, path traversal, SSRF, dependency risk, and data exposure in logs. Report exploitable findings first with severity and a concrete remediation. Do not edit files.",
		),
	},
	{
		id: "team-technical-writer",
		name: "technical-writer",
		description: "Writes and updates docs, READMEs and changelog entries.",
		readonly: false,
		prompt: BASE(
			"Technical Writer",
			"Document the work: update README/docs, usage examples, configuration references and changelog entries so a new developer can use the feature without reading the source. Match the existing documentation tone and structure. Only create new documents when there is no sensible existing place.",
		),
	},
];

/** Default teams shipped with OpenCursor. */
export const BUILTIN_TEAMS: TeamDef[] = [
	{
		id: "team-full-stack",
		name: "Full Development Team",
		description: "A complete squad: product, exploration, architecture, design, frontend, backend, database, devops, QA, review, security and docs.",
		builtin: true,
		subagentIds: BUILTIN_TEAM_SUBAGENTS.map((s) => s.id),
	},
	{
		id: "team-feature-squad",
		name: "Feature Squad",
		description: "Lean squad for shipping a single feature end to end: explore, architect, build front and back, then test and review.",
		builtin: true,
		subagentIds: [
			"team-explorer",
			"team-architect",
			"team-frontend-developer",
			"team-backend-developer",
			"team-qa-engineer",
			"team-code-reviewer",
		],
	},
	{
		id: "team-design-squad",
		name: "Design Squad",
		description: "UX-focused squad for interface work: explore, design the experience, implement the UI, then review.",
		builtin: true,
		subagentIds: ["team-explorer", "team-ui-ux-designer", "team-frontend-developer", "team-code-reviewer"],
	},
	{
		id: "team-quality-squad",
		name: "Quality Squad",
		description: "Hardening squad: QA, code review and security audit over existing work.",
		builtin: true,
		subagentIds: ["team-explorer", "team-qa-engineer", "team-code-reviewer", "team-security-engineer"],
	},
	{
		id: "team-platform-squad",
		name: "Platform Squad",
		description: "Infrastructure squad: data layer, build and CI/CD, plus documentation.",
		builtin: true,
		subagentIds: ["team-explorer", "team-database-engineer", "team-devops-engineer", "team-technical-writer"],
	},
];

/** Merge built-in team subagents into a user's subagent list without duplicating ids. */
export function withBuiltinTeamSubagents(subagents: SubagentDef[]): SubagentDef[] {
	const have = new Set(subagents.map((s) => s.id));
	return [...BUILTIN_TEAM_SUBAGENTS.filter((s) => !have.has(s.id)), ...subagents];
}

/** Merge built-in teams into a user's team list without duplicating ids. */
export function withBuiltinTeams(teams: TeamDef[]): TeamDef[] {
	const have = new Set(teams.map((t) => t.id));
	return [...BUILTIN_TEAMS.filter((t) => !have.has(t.id)), ...teams];
}

/** Resolve the subagents belonging to the given team ids, de-duplicated and ordered by team. */
export function resolveTeamSubagents(teams: TeamDef[], subagents: SubagentDef[], teamIds: string[]): SubagentDef[] {
	const byId = new Map(subagents.map((s) => [s.id, s]));
	const out: SubagentDef[] = [];
	const seen = new Set<string>();
	for (const tid of teamIds) {
		const team = teams.find((t) => t.id === tid);
		if (!team) continue;
		for (const sid of team.subagentIds) {
			const sub = byId.get(sid);
			if (sub && !seen.has(sub.id)) {
				seen.add(sub.id);
				out.push(sub);
			}
		}
	}
	return out;
}

/** Build the `<teams>` context block describing the selected teams and their members. */
export function buildTeamsBlock(teams: TeamDef[], subagents: SubagentDef[], teamIds: string[]): string {
	const byId = new Map(subagents.map((s) => [s.id, s]));
	const selected = teamIds.map((id) => teams.find((t) => t.id === id)).filter((t): t is TeamDef => !!t);
	if (!selected.length) return "";
	const lines = selected.map((t) => {
		const members = t.subagentIds
			.map((sid) => byId.get(sid))
			.filter((s): s is SubagentDef => !!s)
			.map((s) => `  - ${s.name}${s.readonly ? " (read-only)" : ""}: ${s.description}`)
			.join("\n");
		return `- Team "${t.name}": ${t.description}\n${members}`;
	});
	return `\n\n<assigned_teams>\nYou are the project lead for the following team(s). Delegate work to these members with the Task tool by setting "subagent_type" to a member name. Do not use members that are not listed here.\n${lines.join("\n")}\n</assigned_teams>`;
}
