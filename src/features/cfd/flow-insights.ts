import type { CfdStats } from '../../physics/lbm/cfd-simulation.ts'
import type { CfdBody } from '../../physics/lbm/geometry.ts'

export type InsightTone = 'info' | 'good' | 'warn' | 'alert'

export interface FlowInsight {
  /** Stable identifier; a popup is shown when the leading insight's id changes. */
  id: string
  tone: InsightTone
  title: string
  /** Everyday explanation. */
  detail: string
  /** Optional numbers for readers who want them. */
  numbers?: string
}

export interface InsightContext {
  family: CfdBody['family']
  angleOfAttackDeg: number
  hasRearWing: boolean
  highLift: boolean
  sideRelief: boolean
}

const pct = (x: number) => `${Math.round(x * 100)}%`
/** Where along the wing something happens, in words. */
const along = (x: number) => x < 0.2 ? 'right at the front edge' : x < 0.45 ? 'about a third of the way back' : x < 0.7 ? 'about halfway back' : 'near the back edge'
const swing = (stats: CfdStats) => stats.clStd * 1.41

/**
 * Turns solver statistics into short, everyday descriptions of what the air is
 * doing. The first entry is the headline used for the popup.
 */
export function describeFlow(stats: CfdStats | undefined, context: InsightContext): FlowInsight[] {
  if (!stats) return [{ id: 'starting', tone: 'info', title: 'Getting the wind going', detail: 'Setting up the tunnel and letting the first air in.' }]
  if (stats.diverged) return [{ id: 'diverged', tone: 'alert', title: 'The simulation broke down', detail: 'The numbers grew out of control, so the picture is no longer real. Turn the Reynolds number down or pick a finer grid, then press Restart flow.' }]
  if (!stats.settled) {
    const done = pct(Math.min(1, stats.flowThroughs / stats.settleFlowThroughs))
    return [stats.settleFlowThroughs < 1.2
      ? { id: 'adapting', tone: 'info', title: 'Air is adjusting to the change', detail: `The flow was already going, so only the air near the wing has to catch up (${done} done). Numbers update in a moment.` }
      : { id: 'settling', tone: 'info', title: 'Air is still settling', detail: `The first gust is still blowing through the tunnel (${done} done). Numbers are averaged once it has passed.` }]
  }
  const insights: FlowInsight[] = []
  const shedding = stats.strouhal !== null && stats.clStd > 0.03
  const lowRe = stats.reynolds < 2500
  const forces = `Cd ${stats.cdMean.toFixed(2)} · Cl ${stats.clMean.toFixed(2)}`

  if (context.family === 'airfoil' || context.family === 'plate') {
    const sep = stats.suction?.separation ?? null
    const top = context.angleOfAttackDeg < -0.5 ? 'bottom' : 'top'
    const thing = context.family === 'plate' ? 'plate' : 'wing'
    if (sep === null || sep >= 0.92) {
      insights.push(Math.abs(stats.clMean) < 0.04
        ? { id: 'attached-zero', tone: 'good', title: 'Smooth flow, almost no lift', detail: `Air slides evenly over both sides and meets again at the back, so the push up and the push down cancel out. Tilt the ${thing} to make lift.`, numbers: forces }
        : { id: 'attached', tone: 'good', title: 'Smooth flow — the wing is working well', detail: `Air hugs both surfaces all the way to the back edge. Air on top speeds up and its pressure drops, which pulls the ${thing} upward.`, numbers: forces })
    } else if (sep >= (context.highLift ? 0.35 : 0.55)) {
      insights.push({ id: 'te-separation', tone: 'warn', title: context.highLift ? `Air is peeling off the rear of the main wing` : `Air is starting to peel off the ${top}`, detail: context.highLift
        ? 'Over the rear of the main wing the air slows and breaks away, while the slots keep feeding fresh air over the flaps, so lift still holds up. At this small simulated scale (low Reynolds number) this happens sooner than on a full-size airliner; tilt much further and the wing will stall.'
        : `Near the back edge the air can no longer follow the surface and breaks away. Lift is still growing, but more slowly — tilt much further and the ${thing} will stall.`, numbers: `${forces} · separation x/c ${sep.toFixed(2)}` })
    } else if (sep >= 0.18) {
      insights.push({ id: 'stalling', tone: 'alert', title: `The ${thing} is stalling`, detail: `Air breaks away from the ${top} ${along(sep)}, leaving a swirling, dead-air pocket over ${pct(stats.suction!.reversedFraction)} of it. Lift stops increasing and drag shoots up. Lower the angle to recover.`, numbers: `${forces} · separation x/c ${sep.toFixed(2)}` })
    } else {
      insights.push({ id: 'stalled', tone: 'alert', title: `The ${thing} has fully stalled`, detail: `Air can't get around the front edge any more, so the whole ${top} surface sits in a big, tumbling wake. The ${thing} now behaves like a flat board held in the wind: lots of drag, shaky lift.`, numbers: `${forces} · lift swings ±${swing(stats).toFixed(2)}` })
    }
    if (context.highLift) insights.push({ id: 'high-lift', tone: 'info', title: 'Slats and flaps at work', detail: 'Air from underneath squeezes through the gaps and blows over the next surface. A lowered flap curves the air down for much more lift (and drag). A slat mainly helps air stay attached near the front at steep angles — on full-size planes that adds lift, but at this small simulated scale the gain is small.' })
    if (context.angleOfAttackDeg < -0.5 && stats.clMean < -0.04) insights.push({ id: 'negative-lift', tone: 'info', title: 'Pushing downward', detail: `Tilted nose-down, the low-pressure side is now underneath, so the ${thing} is pulled down instead of up — the same trick race-car wings use for grip.` })
    if (shedding && (sep === null || sep >= 0.55)) insights.push({ id: 'te-shedding', tone: 'info', title: 'Little swirls behind the back edge', detail: 'The thin trail behind the wing rolls into small whirls that drift away. They hardly change the average lift or drag.', numbers: `St ${stats.strouhal!.toFixed(2)}` })
    else if (shedding) insights.push({ id: 'stall-shedding', tone: 'warn', title: 'Big whirls are shaking the wing', detail: `Large swirls keep breaking off the broken-away air, making lift wobble up and down. Pilots feel this as a shudder (buffet) just before a stall.`, numbers: `St ${stats.strouhal!.toFixed(2)} · lift swings ±${swing(stats).toFixed(2)}` })
    if (lowRe) insights.push({ id: 'low-re', tone: 'info', title: 'Slow, small-scale air', detail: 'At this Reynolds number the air behaves a bit like it does around an insect or a paper plane: the layer next to the surface is thick and gives up easily. A full-size wing stays attached to steeper angles.', numbers: `Re ${Math.round(stats.reynolds).toLocaleString()}` })
  } else if (context.family === 'bluff') {
    if (!shedding && stats.reynolds < 60) {
      insights.push({ id: 'steady-wake', tone: 'good', title: 'Calm wake with two still eddies', detail: 'Two small whirlpools sit quietly behind the shape and the trail does not wiggle. Speed up the air and they will start to break away one after the other.', numbers: forces })
    } else if (shedding) {
      insights.push({ id: 'karman', tone: 'warn', title: 'Swirls are breaking off left and right', detail: 'Whirls peel off the top and bottom in turn, forming a zig-zag trail. Each one gives the shape a small sideways shove — it is why flagpoles hum and tall chimneys sway in the wind.', numbers: `St ${stats.strouhal!.toFixed(2)} · side force swings ±${swing(stats).toFixed(2)}` })
    } else {
      insights.push({ id: 'wake-unstable', tone: 'info', title: 'The wake is starting to wobble', detail: 'The two whirlpools behind the shape are getting restless. Give it a moment and they will begin to break away in turns.' })
    }
    insights.push({ id: 'pressure-drag', tone: 'info', title: 'Why it is hard to push through the air', detail: 'Air piles up against the front (high pressure) and leaves an empty, low-pressure pocket behind. Front pushing plus back sucking is what makes blunt shapes draggy.', numbers: forces })
  } else {
    if (stats.clMean > 0.15) insights.push({ id: 'vehicle-lift', tone: 'warn', title: 'The car is being lifted', detail: `Air rushes faster over the curved roof, lowering the pressure on top and pulling the car up. That makes the tyres lighter and the car less grippy at speed.${context.sideRelief ? '' : ' With side relief off, no air can escape around the sides, so this is exaggerated.'}`, numbers: forces })
    else if (stats.clMean < -0.15) insights.push({ id: 'downforce', tone: 'good', title: 'The car is being pressed onto the road', detail: 'Overall the air pushes the car down, giving the tyres more grip in corners — paid for with a little extra drag.', numbers: forces })
    else insights.push({ id: 'vehicle-neutral', tone: 'good', title: 'Up and down forces are balanced', detail: 'The pull over the roof and the push underneath roughly cancel out.', numbers: forces })
    if (context.hasRearWing) insights.push({ id: 'rear-wing', tone: 'info', title: 'The rear wing pushes the tail down', detail: 'It is an upside-down wing: it bends air upward, so the air pushes the back of the car down. Tilt it more for grip, less for top speed.' })
    insights.push(shedding
      ? { id: 'vehicle-wake', tone: 'info', title: 'A churning wake behind the car', detail: 'Air can\'t turn the sharp corner at the back, so it tumbles off in swirls. That messy, low-pressure trail sucks the car backward — the biggest source of drag.', numbers: stats.strouhal ? `St ${stats.strouhal.toFixed(2)}` : undefined }
      : { id: 'vehicle-recirculation', tone: 'info', title: 'A pocket of swirling air behind the car', detail: 'Behind the tail the air slows down and circles back. Its low pressure tugs the car backward — the biggest source of drag on a car.' })
    if (context.sideRelief) insights.push({ id: 'side-relief', tone: 'info', title: 'Side relief is on', detail: 'A real car lets air slip around its sides. This option imitates that by letting low-pressure areas around the car refill. Its effect on lift and drag differs from shape to shape, and it is an approximation, not a 3D simulation.' })
  }
  return insights
}
