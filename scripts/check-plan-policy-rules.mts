/**
 * Pre-submit check for the plan artifact format policy.
 *
 * The policy is enforced at `plannotator_auto_submit_review` time. Running it
 * as a script lets the agent see the same issues *before* submitting, instead
 * of paying a round trip on the rejection. Same validator, same wording:
 * `extensions/plan-mode/artifact-policy.ts`.
 */
import {
  formatArtifactPolicyFailure,
  isStandardMarkdownPlanArtifactPath,
  validateArtifactPolicy,
} from "../extensions/plan-mode/artifact-policy.ts";

export type PlanPolicyCheckInput = {
  /** Repo-relative path, e.g. `.pi/plans/pi-kit/plan/2026-10-30-thing.md`. */
  artifactPath: string;
  content: string;
};

export type PlanPolicyCheckResult = {
  ok: boolean;
  output: string;
};

export const checkPlanArtifact = ({
  artifactPath,
  content,
}: PlanPolicyCheckInput): PlanPolicyCheckResult => {
  if (!isStandardMarkdownPlanArtifactPath(artifactPath)) {
    return {
      ok: true,
      output:
        `${artifactPath} is not a standard Markdown plan artifact ` +
        "(.pi/plans/<repo>/plan/YYYY-MM-DD-<slug>.md), so the submit-time " +
        "artifact policy does not apply to it.",
    };
  }

  const result = validateArtifactPolicy({ path: artifactPath, content });
  if (result.approved) {
    return {
      ok: true,
      output: `Plan artifact policy: OK — ${artifactPath}`,
    };
  }

  return {
    ok: false,
    output: formatArtifactPolicyFailure(artifactPath, result.issues),
  };
};
