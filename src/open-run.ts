/** Added to the instructions when this computer left a run open. */
export function openRunLine(runId: string): string {
  return `A diagnosis run is open on this computer (run ${runId}). Call tellagen_resume.`;
}
