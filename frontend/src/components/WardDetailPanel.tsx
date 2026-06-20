import type { WardAggregate } from "../types";
import { hazardDaysForThreshold } from "../lib";
import { DistributionChart } from "./DistributionChart";

type WardDetailPanelProps = {
  aggregate: WardAggregate;
  threshold: number;
  labels: string[];
};

export function WardDetailPanel({ aggregate, threshold, labels }: WardDetailPanelProps) {
  const hazardDays = hazardDaysForThreshold(aggregate.bins, threshold);
  const distribution = {
    row: 0, col: 0, lng: 0, lat: 0,
    bins: aggregate.bins,
    hazardDays,
  };

  return (
    <DistributionChart
      distribution={distribution}
      threshold={threshold}
      labels={labels}
      heading={{ title: aggregate.wardName, subtitle: `${aggregate.pixelCount} pixels` }}
      summaryExtra={{ label: aggregate.subcounty, value: "" }}
    />
  );
}
