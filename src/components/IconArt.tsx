/**
 * The app icon, drawn in JSX for `next/og`: three rising green bars on the
 * ink ground — balances, going the right way.
 */
export function IconArt({ size }: { size: number }) {
  const bar = (left: number, height: number, opacity: number) => ({
    position: "absolute" as const,
    left: size * left,
    bottom: size * 0.22,
    width: size * 0.16,
    height: size * height,
    borderRadius: size * 0.04,
    background: `rgba(61, 220, 151, ${opacity})`,
  });
  return (
    <div style={{ width: size, height: size, background: "#08080b", display: "flex", position: "relative" }}>
      <div style={bar(0.2, 0.22, 0.45)} />
      <div style={bar(0.42, 0.36, 0.7)} />
      <div style={bar(0.64, 0.54, 1)} />
    </div>
  );
}
