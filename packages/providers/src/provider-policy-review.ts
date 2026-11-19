import type { ProviderReviewPeriod, ProviderUsagePolicy } from "@recurs/contracts";

/** Return the recorded evidence window covering the instant, including its start only. */
export function providerReviewAt(policy: ProviderUsagePolicy, now: Date): ProviderReviewPeriod | undefined {
  const time = now.getTime();
  const covers = (period: ProviderReviewPeriod) =>
    time >= Date.parse(period.reviewedAt) && time < Date.parse(period.expiresAt);
  return covers(policy) ? policy : policy.previousReviews?.find(covers);
}
