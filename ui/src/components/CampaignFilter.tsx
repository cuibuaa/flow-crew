export type CampaignFilterValue = "active" | "recent" | "all";

type CampaignFilterProps = {
  value: CampaignFilterValue;
  onChange: (value: CampaignFilterValue) => void;
  hiddenCount: number;
};

const OPTIONS: Array<{ value: CampaignFilterValue; label: string; title: string }> = [
  { value: "active", label: "Active", title: "Campaigns with runs in the last 14 days" },
  { value: "recent", label: "Recent", title: "Campaigns with runs in the last 30 days" },
  { value: "all", label: "All", title: "All campaigns" },
];

export default function CampaignFilter({ value, onChange, hiddenCount }: CampaignFilterProps) {
  return (
    <div className="filter-chips" aria-label="Filter campaigns by latest run">
      {OPTIONS.map((option) => (
        <button
          aria-pressed={value === option.value}
          className={`chip ${value === option.value ? "active" : ""}`}
          key={option.value}
          onClick={() => onChange(option.value)}
          title={option.title}
          type="button"
        >
          {option.label}
        </button>
      ))}
      {hiddenCount > 0 ? <span className="chip" data-testid="campaign-hidden-count">({hiddenCount} hidden)</span> : null}
    </div>
  );
}
