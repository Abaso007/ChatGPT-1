/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as React from "react";
import { Icon } from "../../shared/icons";
import { vscode } from "../../shared/vscode";
import { ModelSelect } from "../../shared/ModelSelect";
import { FeatureConfig, ModelDef, RuleInfo, SkillInfo, SubagentDef, TeamDef, uid } from "../features";

export function RulesPanel({
  features,
  setFeatures,
  rules,
  skills,
  models,
  modelList = [],
}: {
  features: FeatureConfig;
  setFeatures: (f: Partial<FeatureConfig>) => void;
  rules: RuleInfo[];
  skills: SkillInfo[];
  models: string[];
  modelList?: ModelDef[];
}) {
  // Prefer the provider-grouped list; fall back to raw ids.
  const selectModels = modelList.length ? modelList : models.map((id) => ({ id, name: id }));
  const subagents = features.subagents ?? [];
  const teams = features.teams ?? [];
  const activeTeamIds = features.activeTeamIds ?? [];

  // Draft being edited in a modal (`isNew` decides insert vs replace), plus the
  // pending delete awaiting confirmation. Only one dialog is open at a time.
  const [subDraft, setSubDraft] = React.useState<{ value: SubagentDef; isNew: boolean } | null>(null);
  const [teamDraft, setTeamDraft] = React.useState<{ value: TeamDef; isNew: boolean } | null>(null);
  const [confirm, setConfirm] = React.useState<{ kind: "subagent" | "team"; id: string; name: string } | null>(null);

  const saveSub = (value: SubagentDef) => {
    const exists = subagents.some((s) => s.id === value.id);
    setFeatures({ subagents: exists ? subagents.map((s) => (s.id === value.id ? value : s)) : [...subagents, value] });
    setSubDraft(null);
  };
  const deleteSub = (id: string) =>
    setFeatures({
      subagents: subagents.filter((s) => s.id !== id),
      // Keep teams consistent: a removed member can't stay on a roster.
      teams: teams.map((t) => (t.subagentIds.includes(id) ? { ...t, subagentIds: t.subagentIds.filter((x) => x !== id) } : t)),
    });

  const saveTeam = (value: TeamDef) => {
    const exists = teams.some((t) => t.id === value.id);
    setFeatures({ teams: exists ? teams.map((t) => (t.id === value.id ? value : t)) : [...teams, value] });
    setTeamDraft(null);
  };
  const deleteTeam = (id: string) =>
    setFeatures({ teams: teams.filter((t) => t.id !== id), activeTeamIds: activeTeamIds.filter((x) => x !== id) });
  const cloneTeam = (t: TeamDef) =>
    setTeamDraft({ value: { ...t, id: uid("team"), name: `${t.name} (copy)`, builtin: false }, isNew: true });
  const setTeamAssigned = (id: string, assigned: boolean) =>
    setFeatures({ activeTeamIds: assigned ? [...activeTeamIds, id] : activeTeamIds.filter((x) => x !== id) });
  const memberNames = (t: TeamDef) =>
    t.subagentIds.map((sid) => subagents.find((s) => s.id === sid)?.name).filter((n): n is string => !!n);

  return (
    <>
      <h1 className="page-title" style={{ marginBottom: 4 }}>Rules, Skills, Subagents, Teams</h1>
      <p className="panel-hint" style={{ marginBottom: 24 }}>Provide domain-specific knowledge and workflows for the agent</p>

      <div className="rss-section-head">
        <span className="rss-title">Rules <span className="rss-help" title="Rules live in .cursor/rules/*.md and AGENTS.md. Always-apply rules are injected every turn.">?</span></span>
        <button className="btn-ghost sm" onClick={() => vscode.postMessage({ type: "createRule" })}>
          <Icon name="plus" size={12} /> New
        </button>
      </div>
      <p className="panel-hint">Use Rules to guide agent behavior, like enforcing best practices or coding standards. Rules can be applied always, by file path, or manually.</p>
      {rules.length === 0 ? (
        <div className="rss-empty">
          <div className="rss-empty-title">No Rules Yet</div>
          <div className="rss-empty-sub">Create rules to guide agent behavior</div>
          <button className="btn-secondary" onClick={() => vscode.postMessage({ type: "createRule" })}>New Rule</button>
        </div>
      ) : (
        <div className="rss-list">
          {rules.map((r) => (
            <div
              className="rss-row"
              key={r.file}
              title={r.path ? "Open " + r.file : undefined}
              onClick={() => r.path && vscode.postMessage({ type: "openWorkspaceFile", path: r.path })}
            >
              <div className="lr-text">
                <div className="lr-title">{r.description || r.file}</div>
                {r.description && <div className="lr-desc">{r.file}{r.globs ? ` · ${r.globs}` : ""}</div>}
              </div>
              <span className={"badge-tag " + (r.alwaysApply ? "always" : "glob")}>{r.alwaysApply ? "always" : r.globs ? "glob" : "manual"}</span>
              {r.path && (
                <button
                  className="icon-btn rss-del"
                  title="Delete rule"
                  onClick={(e) => { e.stopPropagation(); vscode.postMessage({ type: "deleteRule", path: r.path, name: r.file }); }}
                >
                  <Icon name="trash" size={13} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="rss-section-head" style={{ marginTop: 28 }}>
        <span className="rss-title">Skills <span className="rss-help" title="Skills live in .cursor/skills/*/SKILL.md. The agent reads them when a task matches.">?</span></span>
        <button className="btn-ghost sm" onClick={() => vscode.postMessage({ type: "createSkill" })}>
          <Icon name="plus" size={12} /> New
        </button>
      </div>
      <p className="panel-hint">Skills are specialized capabilities that help the agent accomplish specific tasks. Skills will be invoked by the agent when relevant.</p>
      {skills.length === 0 ? (
        <div className="rss-empty">
          <div className="rss-empty-title">No Skills Yet</div>
          <div className="rss-empty-sub">Create skills for specialized capabilities</div>
          <button className="btn-secondary" onClick={() => vscode.postMessage({ type: "createSkill" })}>New Skill</button>
        </div>
      ) : (
        <div className="rss-list">
          {skills.map((s) => (
            <div
              className="rss-row"
              key={s.path}
              title={"Open " + s.name}
              onClick={() => vscode.postMessage({ type: "openWorkspaceFile", path: s.path })}
            >
              <div className="lr-text">
                <div className="lr-title">{s.name}</div>
                <div className="lr-desc rss-clamp">{s.description}</div>
              </div>
              <button
                className="icon-btn rss-del"
                title="Delete skill"
                onClick={(e) => { e.stopPropagation(); vscode.postMessage({ type: "deleteSkill", path: s.path, name: s.name }); }}
              >
                <Icon name="trash" size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="rss-section-head" style={{ marginTop: 28 }}>
        <span className="rss-title">Subagents <span className="rss-help" title="The agent can launch subagents for focused subtasks via the Task tool. Use a fast/cheap model for subagents.">?</span></span>
        <button className="btn-ghost sm" onClick={() => setSubDraft({ value: { id: uid("sub"), name: "", description: "", prompt: "", readonly: true }, isNew: true })}>
          <Icon name="plus" size={12} /> New
        </button>
      </div>
      <p className="panel-hint">Create specialized agents for complex tasks. Subagents can be invoked by the agent to handle focused work in parallel.</p>
      <div className="row stacked" style={{ borderBottom: "none", paddingTop: 4 }}>
        <div className="row-text">
          <div className="row-title">Subagent Model</div>
          <div className="row-desc">Default model for all subagents. A per-subagent override takes precedence; empty = inherit the chat model.</div>
        </div>
        <ModelSelect
          models={selectModels}
          value={features.subagentModel}
          onChange={(id) => setFeatures({ subagentModel: id })}
          customItems={[{ value: "", label: "Inherit chat model", desc: "use whatever the chat uses" }]}
        />
      </div>
      {subagents.length === 0 ? (
        <div className="rss-empty">
          <div className="rss-empty-title">No Subagents Yet</div>
          <div className="rss-empty-sub">Create specialized agents to handle focused tasks</div>
          <button className="btn-secondary" onClick={() => setSubDraft({ value: { id: uid("sub"), name: "", description: "", prompt: "", readonly: true }, isNew: true })}>New Subagent</button>
        </div>
      ) : (
        <table className="cfg-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Description</th>
              <th className="c-mode">Mode</th>
              <th className="c-model">Model</th>
              <th className="c-actions" />
            </tr>
          </thead>
          <tbody>
            {subagents.map((sub) => (
              <tr key={sub.id} onDoubleClick={() => setSubDraft({ value: sub, isNew: false })}>
                <td className="c-name" title={sub.name}>{sub.name || "(unnamed)"}</td>
                <td className="c-desc" title={sub.description}>{sub.description || "—"}</td>
                <td className="c-mode">
                  <span className={"badge-tag " + (sub.readonly ? "glob" : "always")}>{sub.readonly ? "read-only" : "read-write"}</span>
                </td>
                <td className="c-model" title={sub.model || "Inherits the subagent / chat model"}>{sub.model || "inherit"}</td>
                <td className="c-actions">
                  <button className="btn-ghost sm" onClick={() => setSubDraft({ value: sub, isNew: false })}>Edit</button>
                  <button className="icon-btn" title="Delete subagent" onClick={() => setConfirm({ kind: "subagent", id: sub.id, name: sub.name })}>
                    <Icon name="trash" size={13} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="rss-section-head" style={{ marginTop: 28 }}>
        <span className="rss-title">Teams <span className="rss-help" title="A team is a group of subagents. In Project mode you assign one or more teams and the agent becomes their project lead.">?</span></span>
        <button className="btn-ghost sm" onClick={() => setTeamDraft({ value: { id: uid("team"), name: "", description: "", subagentIds: [] }, isNew: true })}>
          <Icon name="plus" size={12} /> New
        </button>
      </div>
      <p className="panel-hint">Group subagents into teams, then assign the team(s) that should work on a task in Project mode. Built-in teams cover a full development squad.</p>
      {teams.length === 0 ? (
        <div className="rss-empty">
          <div className="rss-empty-title">No Teams Yet</div>
          <div className="rss-empty-sub">Group subagents into a squad you can assign in Project mode</div>
          <button className="btn-secondary" onClick={() => setTeamDraft({ value: { id: uid("team"), name: "", description: "", subagentIds: [] }, isNew: true })}>New Team</button>
        </div>
      ) : (
        <table className="cfg-table">
          <thead>
            <tr>
              <th className="c-check" title="Assigned to Project mode runs">Use</th>
              <th>Team</th>
              <th>Members</th>
              <th className="c-count">Size</th>
              <th className="c-actions" />
            </tr>
          </thead>
          <tbody>
            {teams.map((team) => {
              const names = memberNames(team);
              return (
                <tr key={team.id} onDoubleClick={() => setTeamDraft({ value: team, isNew: false })}>
                  <td className="c-check">
                    <input
                      type="checkbox"
                      title="Assign this team to Project mode runs"
                      checked={activeTeamIds.includes(team.id)}
                      onChange={(e) => setTeamAssigned(team.id, e.target.checked)}
                    />
                  </td>
                  <td className="c-name">
                    {team.name || "(unnamed)"}
                    {team.builtin && <span className="badge-tag always" style={{ marginLeft: 6 }}>built-in</span>}
                    {team.description && <div className="cfg-sub" title={team.description}>{team.description}</div>}
                  </td>
                  <td className="c-desc" title={names.join(", ")}>{names.join(", ") || "no members"}</td>
                  <td className="c-count">{team.subagentIds.length}</td>
                  <td className="c-actions">
                    <button className="btn-ghost sm" onClick={() => setTeamDraft({ value: team, isNew: false })}>Edit</button>
                    <button className="icon-btn" title="Duplicate team" onClick={() => cloneTeam(team)}>
                      <Icon name="copy" size={13} />
                    </button>
                    {!team.builtin && (
                      <button className="icon-btn" title="Delete team" onClick={() => setConfirm({ kind: "team", id: team.id, name: team.name })}>
                        <Icon name="trash" size={13} />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {subDraft && (
        <SubagentModal
          subagent={subDraft.value}
          isNew={subDraft.isNew}
          existingNames={subagents.filter((s) => s.id !== subDraft.value.id).map((s) => s.name)}
          selectModels={selectModels}
          onClose={() => setSubDraft(null)}
          onSave={saveSub}
        />
      )}
      {teamDraft && (
        <TeamModal
          team={teamDraft.value}
          isNew={teamDraft.isNew}
          subagents={subagents}
          onClose={() => setTeamDraft(null)}
          onSave={saveTeam}
        />
      )}
      {confirm && (
        <ConfirmDeleteModal
          kind={confirm.kind}
          name={confirm.name}
          detail={
            confirm.kind === "subagent"
              ? (() => {
                  const used = teams.filter((t) => t.subagentIds.includes(confirm.id)).map((t) => t.name);
                  return used.length ? `It will also be removed from ${used.length === 1 ? "the team" : "the teams"} ${used.join(", ")}.` : undefined;
                })()
              : activeTeamIds.includes(confirm.id)
                ? "This team is currently assigned to Project mode and will be unassigned."
                : undefined
          }
          onClose={() => setConfirm(null)}
          onConfirm={() => {
            if (confirm.kind === "subagent") deleteSub(confirm.id);
            else deleteTeam(confirm.id);
            setConfirm(null);
          }}
        />
      )}
    </>
  );
}

/** Full add/edit dialog for a subagent: identity, capability, model and system prompt. */
function SubagentModal({
  subagent,
  isNew,
  existingNames,
  selectModels,
  onClose,
  onSave,
}: {
  subagent: SubagentDef;
  isNew: boolean;
  existingNames: string[];
  selectModels: { id: string; name: string }[] | ModelDef[];
  onClose: () => void;
  onSave: (s: SubagentDef) => void;
}) {
  const [draft, setDraft] = React.useState<SubagentDef>(subagent);
  const set = (patch: Partial<SubagentDef>) => setDraft((d) => ({ ...d, ...patch }));
  const name = draft.name.trim();
  // The agent selects a subagent by name, so it must be unique and token-like.
  const error = !name
    ? "A name is required."
    : /\s/.test(name)
      ? "Use a single word without spaces (e.g. backend-developer)."
      : existingNames.some((n) => n.trim().toLowerCase() === name.toLowerCase())
        ? "Another subagent already uses this name."
        : !draft.description.trim()
          ? "A description is required — the agent uses it to decide when to delegate."
          : "";

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-lg" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{isNew ? "New Subagent" : "Edit Subagent"}</h2>
          <button className="icon-btn close" onClick={onClose} title="Close">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="modal-body">
          <label className="fc-field">
            <span>Name</span>
            <input value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="backend-developer" autoFocus />
            <span className="fc-help">The agent passes this as <code>subagent_type</code> when delegating. One word, no spaces.</span>
          </label>
          <label className="fc-field">
            <span>Description</span>
            <input value={draft.description} onChange={(e) => set({ description: e.target.value })} placeholder="Implements server-side logic, APIs and persistence" />
            <span className="fc-help">Shown to the agent so it knows when to use this subagent.</span>
          </label>
          <div className="fc-field">
            <span>Capability</span>
            <label className="fc-inline">
              <input type="checkbox" checked={draft.readonly} onChange={(e) => set({ readonly: e.target.checked })} />
              Read-only — can explore and report, but cannot edit files or run commands
            </label>
          </div>
          <label className="fc-field">
            <span>Model</span>
            <ModelSelect
              models={selectModels as ModelDef[]}
              value={draft.model ?? ""}
              onChange={(id) => set({ model: id })}
              customItems={[{ value: "", label: "Use subagent / chat model", desc: "inherit the default" }]}
            />
          </label>
          <label className="fc-field">
            <span>System Prompt</span>
            <textarea
              rows={12}
              className="fc-mono"
              value={draft.prompt}
              onChange={(e) => set({ prompt: e.target.value })}
              placeholder={"You are the ...\n\nMission, expertise, workflow, deliverable and constraints for this specialist."}
            />
            <span className="fc-help">Replaces the persona for this subagent's run. Leave empty to inherit the chat's system prompt.</span>
          </label>
          {error && <div className="fc-error">{error}</div>}
        </div>
        <div className="modal-foot">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!!error} onClick={() => onSave({ ...draft, name, description: draft.description.trim() })}>
            {isNew ? "Create Subagent" : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Full add/edit dialog for a team: identity plus roster selection. */
function TeamModal({
  team,
  isNew,
  subagents,
  onClose,
  onSave,
}: {
  team: TeamDef;
  isNew: boolean;
  subagents: SubagentDef[];
  onClose: () => void;
  onSave: (t: TeamDef) => void;
}) {
  const [draft, setDraft] = React.useState<TeamDef>(team);
  const set = (patch: Partial<TeamDef>) => setDraft((d) => ({ ...d, ...patch }));
  const toggle = (id: string) =>
    set({ subagentIds: draft.subagentIds.includes(id) ? draft.subagentIds.filter((x) => x !== id) : [...draft.subagentIds, id] });
  const name = draft.name.trim();
  const error = !name ? "A name is required." : draft.subagentIds.length === 0 ? "Select at least one member." : "";

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-lg" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{isNew ? "New Team" : "Edit Team"}</h2>
          <button className="icon-btn close" onClick={onClose} title="Close">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="modal-body">
          <label className="fc-field">
            <span>Name</span>
            <input value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="Feature Squad" autoFocus />
          </label>
          <label className="fc-field">
            <span>Description</span>
            <input value={draft.description} onChange={(e) => set({ description: e.target.value })} placeholder="What this team is for and when to assign it" />
          </label>
          <div className="fc-field">
            <div className="fc-field-head">
              <span>Members ({draft.subagentIds.length} of {subagents.length})</span>
              <div className="fc-field-actions">
                <button className="btn-ghost sm" onClick={() => set({ subagentIds: subagents.map((s) => s.id) })}>Select all</button>
                <button className="btn-ghost sm" onClick={() => set({ subagentIds: [] })}>Clear</button>
              </div>
            </div>
            {subagents.length === 0 ? (
              <div className="row-desc">Create subagents first — a team is a group of them.</div>
            ) : (
              <div className="member-picker">
                {subagents.map((sub) => (
                  <label className={"member-option" + (draft.subagentIds.includes(sub.id) ? " on" : "")} key={sub.id}>
                    <input type="checkbox" checked={draft.subagentIds.includes(sub.id)} onChange={() => toggle(sub.id)} />
                    <span className="mo-text">
                      <span className="mo-name">
                        {sub.name}
                        {sub.readonly && <span className="badge-tag glob">read-only</span>}
                      </span>
                      <span className="mo-desc">{sub.description}</span>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
          {error && <div className="fc-error">{error}</div>}
        </div>
        <div className="modal-foot">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!!error} onClick={() => onSave({ ...draft, name, description: draft.description.trim() })}>
            {isNew ? "Create Team" : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Destructive-action confirmation shared by subagent and team deletion. */
function ConfirmDeleteModal({
  kind,
  name,
  detail,
  onClose,
  onConfirm,
}: {
  kind: "subagent" | "team";
  name: string;
  detail?: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Delete {kind}</h2>
          <button className="icon-btn close" onClick={onClose} title="Close">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="modal-body">
          <p className="confirm-text">
            Delete the {kind} <b>{name || "(unnamed)"}</b>? This cannot be undone.
          </p>
          {detail && <p className="confirm-detail">{detail}</p>}
        </div>
        <div className="modal-foot">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-danger" onClick={onConfirm}>Delete</button>
        </div>
      </div>
    </div>
  );
}
