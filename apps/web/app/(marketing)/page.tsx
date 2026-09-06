import { Hero } from '@/components/marketing/hero.tsx'
import { Pillars } from '@/components/marketing/pillars.tsx'
import { Evidence } from '@/components/marketing/evidence.tsx'
import { FixPrompt } from '@/components/marketing/fix-prompt.tsx'
import { AnswerEngines } from '@/components/marketing/answer-engines.tsx'
import { Monitoring } from '@/components/marketing/monitoring.tsx'
import { Safety } from '@/components/marketing/safety.tsx'
import { PlansPreview } from '@/components/marketing/plans-preview.tsx'
import { Faq } from '@/components/marketing/faq.tsx'
import { FinalCta } from '@/components/marketing/final-cta.tsx'
import { HomeMotion } from '@/components/marketing/home-motion.tsx'

/**
 * The landing page.
 *
 * Ordered as the objection is actually raised: hook, then the thing itself,
 * then what it covers, then why any of it can be believed, then what you leave
 * with, then depth, then the reason not to — answered last and at length,
 * because "will this attack my site" is the question that stops a stranger
 * from typing their domain into a security tool.
 *
 * Every number on it is derived from the registry or from plans.ts. Nothing
 * here reads a session or a database, so the whole page prerenders to static
 * HTML — which matters on the one page whose Core Web Vitals this product's
 * own engine would be measuring.
 *
 * HomeMotion is the page's one motion island: it renders the scan rail and
 * runs the scroll choreography (GSAP + ScrollTrigger, dynamically imported)
 * against the data-motion attributes the sections carry. The server renders
 * every state final; the island only ever hides what it is about to reveal.
 */
export default function LandingPage() {
  return (
    <>
      <Hero />
      <Pillars />
      <Evidence />
      <FixPrompt />
      <AnswerEngines />
      <Monitoring />
      <Safety />
      <PlansPreview />
      <Faq />
      <FinalCta />
      <HomeMotion />
    </>
  )
}
