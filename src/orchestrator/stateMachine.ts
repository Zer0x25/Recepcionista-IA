import { State } from "@prisma/client";

export const VALID_TRANSITIONS: Record<State, State[]> = {
  [State.NEW]: [State.CLASSIFYING],
  [State.CLASSIFYING]: [State.ANSWERING, State.HANDOFF],
  [State.ANSWERING]: [State.WAITING_USER],
  [State.WAITING_USER]: [State.CLASSIFYING],
  [State.HANDOFF]: [State.HANDOFF, State.CLOSED],
  [State.CLOSED]: [State.NEW],
};

export function isValidTransition(from: State, to: State): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}
