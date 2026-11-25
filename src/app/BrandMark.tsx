/** WindlyLab logo: a clean aerofoil with a streamline bending over it and one under it. */
export default function BrandMark({ size = 18 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="4 6 56 52" aria-hidden="true" focusable="false">
    <g fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" opacity="0.6">
      <path d="M8 22C20 22 26 16 36 16S52 20 57 22" />
      <path d="M8 47C22 47 30 44 40 44S52 45 57 46" />
    </g>
    <path d="M10 33C10 28 17 25.5 27 25.5C37 25.5 47 28 55 32C46 33.5 36 35.5 27 37C17 38.5 10 37.5 10 33Z" fill="currentColor" />
  </svg>
}
