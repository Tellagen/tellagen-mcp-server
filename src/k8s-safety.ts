/**
 * The Kubernetes safety check.
 *
 * A diagnosis must only read a cluster. The server cannot stop a call that a
 * client makes on a person's computer, but the model can ask Kubernetes what
 * the identity of its Kubernetes server may do, with `kubectl auth can-i`.
 * Those commands read access rules and change nothing. Each answer is one
 * check with a stable id: `ok` when the answer is no, `failed` when it is yes,
 * `warning` or `not_checked` when the command could not run.
 *
 * The result says what the identity COULD do. It does not say what a model
 * will do, and a session that is not listened by `tellagen-mcp-server listen`
 * has no guard on its commands. Never call such a session read-only.
 */
export const KUBERNETES_SAFETY_CHECKS = [
  { id: "k8s_can_create_pods", label: "Can create pods", command: "kubectl auth can-i create pods" },
  { id: "k8s_can_delete_pods", label: "Can delete pods", command: "kubectl auth can-i delete pods" },
  { id: "k8s_can_exec", label: "Can run commands in pods", command: "kubectl auth can-i create pods --subresource=exec" },
  { id: "k8s_can_read_secrets", label: "Can read secrets", command: "kubectl auth can-i get secrets" },
] as const;

export const KUBERNETES_SAFETY_CHECK_IDS = KUBERNETES_SAFETY_CHECKS.map((check) => check.id) as [
  (typeof KUBERNETES_SAFETY_CHECKS)[number]["id"],
  ...(typeof KUBERNETES_SAFETY_CHECKS)[number]["id"][],
];

export const KUBERNETES_SAFETY_STATUSES = ["ok", "failed", "warning", "not_checked"] as const;

export interface KubernetesSafetyCheck {
  id: (typeof KUBERNETES_SAFETY_CHECK_IDS)[number];
  status: (typeof KUBERNETES_SAFETY_STATUSES)[number];
}

/** The protocol, in words for a model. One text for every place that teaches it. */
export const KUBERNETES_SAFETY_PROTOCOL =
  "Kubernetes safety check: with the same kubeconfig and context the Kubernetes MCP server uses, run kubectl auth can-i for create pods, delete pods, create pods with --subresource=exec and get secrets. Print no output and no names. Report each as a check with the ids k8s_can_create_pods, k8s_can_delete_pods, k8s_can_exec and k8s_can_read_secrets: status ok when the answer is no, failed when it is yes, warning or not_checked when the command could not run. The commands read access rules and change nothing. The result says what the identity could do, not what a model will do: a session that is not listened has no guard, so never call it read-only.";

export type KubernetesSafetyVerdict = "read_only" | "can_change" | "not_checked";

/** The same reading the Tellagen web page makes of the four checks. */
export function kubernetesSafetyVerdict(checks: readonly KubernetesSafetyCheck[]): KubernetesSafetyVerdict {
  const byId = new Map(checks.map((check) => [check.id, check.status]));
  const statuses = KUBERNETES_SAFETY_CHECKS.map((check) => byId.get(check.id));
  if (statuses.some((status) => status === "failed")) return "can_change";
  return statuses.every((status) => status === "ok") ? "read_only" : "not_checked";
}
