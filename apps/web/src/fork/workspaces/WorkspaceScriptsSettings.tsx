import type { EnvironmentId, ProjectId, ProjectWorkspaceScripts } from "@t3tools/contracts";
import { PlayIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { SettingsSection } from "../../components/settings/settingsLayout";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { randomUUID } from "../../lib/utils";
import { useAtomCommand } from "../../state/use-atom-command";
import { BashEditor } from "./BashEditor";
import { forkWorkspaceEnvironment, useProjectWorkspaceScripts } from "./state";

const AUTOSAVE_DELAY_MS = 600;

type ScriptsDraft = Omit<ProjectWorkspaceScripts, "projectId">;

/** One project's workspace setup, archive, and extra scripts. */
export function WorkspaceScriptsSettings({
  projects,
}: {
  projects: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly id: ProjectId }>;
}) {
  const primary = projects[0];
  if (primary === undefined) return null;
  return (
    <WorkspaceScriptsEditor
      key={`${primary.environmentId}:${primary.id}`}
      primary={primary}
      projects={projects}
    />
  );
}

function WorkspaceScriptsEditor({
  primary,
  projects,
}: {
  primary: { readonly environmentId: EnvironmentId; readonly id: ProjectId };
  projects: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly id: ProjectId }>;
}) {
  const saved = useProjectWorkspaceScripts(primary.environmentId, primary.id);
  const command = useAtomCommand(forkWorkspaceEnvironment.command);
  // Null while nothing is unsaved, so updates from other devices show through.
  const [draft, setDraft] = useState<ScriptsDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const pending = useRef<{ timer: number; value: ScriptsDraft } | null>(null);
  const shown: ScriptsDraft = draft ?? saved;

  const save = async (value: ScriptsDraft) => {
    pending.current = null;
    setSaving(true);
    await Promise.all(
      projects.map((project) =>
        command({
          environmentId: project.environmentId,
          input: { type: "setProjectScripts", scripts: { ...value, projectId: project.id } },
        }),
      ),
    );
    setSaving(false);
    // Keep the draft if more edits arrived while this save was in flight.
    if (pending.current === null) setDraft(null);
  };

  const flush = () => {
    const queued = pending.current;
    if (queued === null) return;
    window.clearTimeout(queued.timer);
    void save(queued.value);
  };

  const edit = (change: (current: ScriptsDraft) => ScriptsDraft) => {
    const next = change(shown);
    setDraft(next);
    if (pending.current) window.clearTimeout(pending.current.timer);
    pending.current = {
      value: next,
      timer: window.setTimeout(() => void save(next), AUTOSAVE_DELAY_MS),
    };
  };

  // Leaving the page must not drop the last keystrokes.
  const flushOnLeave = useEffectEvent(flush);
  useEffect(() => () => flushOnLeave(), []);

  return (
    <SettingsSection
      id="workspace-scripts"
      title="Workspace scripts"
      titleAction={
        saving ? <span className="text-muted-foreground/60 text-xs">Saving…</span> : null
      }
    >
      <div className="flex flex-col gap-5 px-3 py-3 sm:px-4">
        <ScriptField label="Setup script">
          <BashEditor
            label="Setup script"
            value={shown.setup}
            minRows={8}
            onChange={(setup) => edit((current) => ({ ...current, setup }))}
            onBlur={flush}
          />
        </ScriptField>
        <ScriptField label="Archive script">
          <BashEditor
            label="Archive script"
            value={shown.archive}
            minRows={6}
            onChange={(archive) => edit((current) => ({ ...current, archive }))}
            onBlur={flush}
          />
        </ScriptField>
        <ScriptField label="Scripts">
          <div className="flex flex-col gap-3">
            {shown.scripts.map((script) => (
              <div
                key={script.id}
                className="flex flex-col gap-2 rounded-lg border border-border p-2.5"
              >
                <div className="flex items-center gap-2">
                  <PlayIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <Input
                    aria-label="Script name"
                    placeholder="Name"
                    value={script.name}
                    onChange={(event) => {
                      const name = event.target.value;
                      edit((current) => ({
                        ...current,
                        scripts: current.scripts.map((entry) =>
                          entry.id === script.id ? { ...entry, name } : entry,
                        ),
                      }));
                    }}
                    onBlur={flush}
                  />
                  <Button
                    size="icon-sm"
                    variant="ghost-destructive"
                    aria-label={`Remove ${script.name || "script"}`}
                    onClick={() =>
                      edit((current) => ({
                        ...current,
                        scripts: current.scripts.filter((entry) => entry.id !== script.id),
                      }))
                    }
                  >
                    <Trash2Icon />
                  </Button>
                </div>
                <BashEditor
                  label={`${script.name || "Script"} command`}
                  value={script.command}
                  minRows={3}
                  onChange={(commandText) =>
                    edit((current) => ({
                      ...current,
                      scripts: current.scripts.map((entry) =>
                        entry.id === script.id ? { ...entry, command: commandText } : entry,
                      ),
                    }))
                  }
                  onBlur={flush}
                />
              </div>
            ))}
            <div>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  edit((current) => ({
                    ...current,
                    scripts: [
                      ...current.scripts,
                      { id: randomUUID().slice(0, 8), name: "", command: "" },
                    ],
                  }))
                }
              >
                <PlusIcon />
                Add script
              </Button>
            </div>
          </div>
        </ScriptField>
      </div>
    </SettingsSection>
  );
}

function ScriptField(props: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="font-medium text-sm">{props.label}</h3>
      {props.children}
    </div>
  );
}
