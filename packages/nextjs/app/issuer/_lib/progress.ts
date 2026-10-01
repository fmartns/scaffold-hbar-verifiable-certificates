import type { StepState } from "../_components/ProgressSteps";

export type StepStates<S extends string> = Record<S, StepState>;

export const initialSteps = <S extends string>(ids: readonly S[]): StepStates<S> =>
  Object.fromEntries(ids.map(id => [id, "pending"])) as StepStates<S>;

export const applyProgress = <S extends string>(
  states: StepStates<S>,
  event: { step: S; state: "active" | "done" },
): StepStates<S> => ({ ...states, [event.step]: event.state });

/** Marks the step that was running when the flow failed. */
export const failActive = <S extends string>(states: StepStates<S>): StepStates<S> => {
  const entries = Object.entries(states) as [S, StepState][];
  const active = entries.find(([, state]) => state === "active")?.[0] ?? entries.find(([, s]) => s === "pending")?.[0];
  return active ? { ...states, [active]: "failed" } : states;
};
