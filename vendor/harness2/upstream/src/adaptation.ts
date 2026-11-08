export interface AdaptationPolicy {
  capabilities: "fixed" | "dynamic";
  reuse: boolean;
  learnMethods: boolean;
}
export function validateAdaptationPolicy(p: AdaptationPolicy): void {
  if (
    !p ||
    Object.keys(p).some(
      (k) => !["capabilities", "reuse", "learnMethods"].includes(k),
    ) ||
    !["fixed", "dynamic"].includes(p.capabilities) ||
    typeof p.reuse !== "boolean" ||
    typeof p.learnMethods !== "boolean"
  )
    throw new Error("Invalid adaptation policy");
}
