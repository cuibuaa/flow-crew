export default function RunTitleDisclosure({ shortName, fullTitle }: { shortName: string; fullTitle: string }) {
  if (shortName === fullTitle) return <span className="campaign-run-title-label">{shortName}</span>;
  return (
    <details className="campaign-run-title">
      <summary className="campaign-run-title-summary" aria-label={`Show full title for ${shortName}`}>
        <span className="campaign-run-title-label">{shortName}</span>
      </summary>
      <span className="campaign-run-title-full">{fullTitle}</span>
    </details>
  );
}
