/**
 * utils/pageTemplates.js — Pre-built landing-page templates per industry.
 *
 * Each template is a complete `sections` array ready to drop into the
 * landing_pages.sections column. Admins click "Use template" → a new
 * draft page is created with this content, then they customise.
 */
'use strict';

const TEMPLATES = [
  {
    id: 'real-estate',
    name: 'Real Estate — Buyer Funnel',
    industry: 'Real Estate',
    description: 'Hero with property image, features grid, embedded enquiry form, testimonials.',
    theme_color: '#0ea5e9',
    sections: [
      { type: 'hero', eyebrow: 'NEW LAUNCH', heading: 'Your dream home, ready to move in.',
        subheading: '2 & 3 BHK apartments in the heart of the city — premium amenities, school nearby, metro at the doorstep.',
        cta_label: 'Book a site visit', cta_url: '#contact', image_url: '' },
      { type: 'features', heading: 'Why families choose us',
        items: [
          { icon: '🏊', title: 'Premium amenities', body: 'Swimming pool, gym, clubhouse, kids play area, jogging track.' },
          { icon: '🚇', title: 'Prime location', body: 'Metro station 200m away. Top schools and hospitals within 2 km.' },
          { icon: '✅', title: 'RERA approved', body: 'All units fully registered. Loan-ready. On-time possession guaranteed.' }
        ]},
      { type: 'form', heading: 'Book your site visit',
        subheading: 'Fill the form and our property advisor will call you back within 30 minutes.', form_slug: '' },
      { type: 'testimonials', heading: 'Recent buyers',
        items: [
          { quote: 'Smooth process from booking to possession. Highly recommended.', author: 'Rajesh M.', role: '3 BHK owner' },
          { quote: 'The team helped us with home loan paperwork end to end.', author: 'Priya S.', role: '2 BHK owner' }
        ]},
      { type: 'faq', heading: 'Common questions',
        items: [
          { q: 'What is the price range?', a: '2 BHK starts at ₹85L, 3 BHK at ₹1.25 Cr. EMI options available.' },
          { q: 'Is the project RERA-approved?', a: 'Yes, RERA registration number is shared in the brochure on submitting the form.' },
          { q: 'When is the possession?', a: 'Tower A: Dec 2026. Tower B: Mar 2027. Construction is on schedule.' }
        ]},
      { type: 'contact', heading: 'Reach our sales team',
        email: 'sales@yourcompany.com', phone: '+91 98765 43210', address: 'Sales office: Sector 12, Your City' },
      { type: 'footer', text: '© ' + new Date().getFullYear() + ' Your Real Estate Pvt Ltd · All rights reserved.' }
    ]
  },
  {
    id: 'coaching',
    name: 'Coaching / EdTech — Admissions',
    industry: 'Coaching',
    description: 'Hero with course headline, batch features, fee table, testimonials, FAQ, enquiry form.',
    theme_color: '#7c3aed',
    sections: [
      { type: 'hero', eyebrow: 'ADMISSIONS OPEN', heading: 'Crack JEE / NEET with India\'s top mentors.',
        subheading: 'Live classes, doubt sessions, weekly mock tests. 95% selection rate in our 2025 batch.',
        cta_label: 'Book a free demo class', cta_url: '#contact' },
      { type: 'features', heading: 'Why our students succeed',
        items: [
          { icon: '👨‍🏫', title: 'IIT/AIIMS faculty', body: 'Every teacher is an IIT or AIIMS alumnus with 5+ years of coaching experience.' },
          { icon: '📊', title: 'Weekly progress tracking', body: 'Parents get a detailed report card every Sunday on WhatsApp.' },
          { icon: '💯', title: '95% selection rate', body: '247 out of 260 students in our 2025 JEE batch scored above qualifying cutoff.' }
        ]},
      { type: 'pricing', heading: 'Fee structure',
        items: [
          { name: '1-year program', price: '₹85,000', features: ['180 live classes', 'Daily doubt sessions', '36 mock tests', 'Study material included'], cta_label: 'Enrol now', cta_url: '#contact', featured: 0 },
          { name: '2-year program', price: '₹1,40,000', features: ['360 live classes', 'Personal mentor', '72 mock tests', 'Free trial test paper', 'EMI available'], cta_label: 'Enrol now', cta_url: '#contact', featured: 1 },
          { name: 'Crash course', price: '₹35,000', features: ['60 live classes', 'Last-minute revision', '12 mock tests', 'Doubt clearing'], cta_label: 'Enrol now', cta_url: '#contact', featured: 0 }
        ]},
      { type: 'form', heading: 'Book a free demo class', subheading: 'See how we teach before you decide.', form_slug: '' },
      { type: 'faq', heading: 'Parents ask',
        items: [
          { q: 'How are doubts cleared?', a: 'Every batch has a dedicated WhatsApp group. Faculty answer doubts within 30 minutes during teaching hours.' },
          { q: 'Are recordings available?', a: 'Yes, every live class is recorded and accessible in the student portal for the full course duration.' },
          { q: 'What if my child cannot attend a live class?', a: 'No worries — they can watch the recording and submit doubts in the WhatsApp group.' }
        ]},
      { type: 'footer', text: '© ' + new Date().getFullYear() + ' Your Coaching Institute · All rights reserved.' }
    ]
  },
  {
    id: 'solar',
    name: 'Solar / Renewable — Lead Capture',
    industry: 'Solar',
    description: 'Hero with savings claim, ROI calculator features, embedded enquiry form, govt subsidy callout.',
    theme_color: '#f59e0b',
    sections: [
      { type: 'hero', eyebrow: 'SAVE 90% ON ELECTRICITY', heading: 'Power your home with the sun.',
        subheading: 'Premium solar panels installed in 7 days. Govt subsidy up to ₹78,000. Pays back in 4 years.',
        cta_label: 'Get free site survey', cta_url: '#contact' },
      { type: 'features', heading: 'Why go solar with us',
        items: [
          { icon: '💰', title: '₹40K+ savings/year', body: 'Average household saves ₹40,000 a year on electricity bills with our 5kW system.' },
          { icon: '🏛️', title: 'Govt subsidy assistance', body: 'We handle the paperwork. PM Surya Ghar Yojna gives up to ₹78,000 subsidy.' },
          { icon: '🔧', title: '25-year warranty', body: 'Tier-1 panels with 25-year performance warranty. 5-year free maintenance.' }
        ]},
      { type: 'cta', heading: 'See your savings in 60 seconds.',
        subheading: 'Tell us your last electricity bill amount — we will calculate your exact savings.',
        cta_label: 'Calculate my savings', cta_url: '#contact' },
      { type: 'form', heading: 'Free site survey + quote',
        subheading: 'Our engineer will visit your home, measure roof space, and give you an exact quote — no obligation.', form_slug: '' },
      { type: 'testimonials', heading: 'Happy customers',
        items: [
          { quote: 'My ₹6000/month bill is now ₹500. Recovered the cost in 4 years exactly.', author: 'Anil P.', role: 'Pune — 5kW system' },
          { quote: 'Subsidy paperwork was a breeze. Professional install team.', author: 'Mehta family', role: 'Ahmedabad — 8kW system' }
        ]},
      { type: 'faq', heading: 'You might be wondering',
        items: [
          { q: 'How long does installation take?', a: '7 days from order. Day 1: site survey. Days 2-5: panel + inverter install. Days 6-7: meter change + grid connection.' },
          { q: 'What if there\'s no sun for days?', a: 'Grid-tied systems automatically draw from the electricity grid when solar is insufficient. You only pay for what you draw.' },
          { q: 'Is the subsidy guaranteed?', a: 'PM Surya Ghar Yojna subsidy is paid directly to your bank account within 60 days of installation.' }
        ]},
      { type: 'footer', text: '© ' + new Date().getFullYear() + ' Your Solar Company · MNRE Channel Partner.' }
    ]
  },
  {
    id: 'gym',
    name: 'Gym / Fitness — Trial Signup',
    industry: 'Gym',
    description: 'Hero with body transformation claim, plan grid, trial form.',
    theme_color: '#dc2626',
    sections: [
      { type: 'hero', eyebrow: 'JOIN TODAY — 7-DAY FREE TRIAL', heading: 'Stronger you. Starts now.',
        subheading: 'AC gym, certified trainers, group classes, nutrition guidance. Members lose an average of 6 kg in 3 months.',
        cta_label: 'Claim my free trial', cta_url: '#contact' },
      { type: 'pricing', heading: 'Membership plans',
        items: [
          { name: '1-month', price: '₹1,999', features: ['Gym access', '1 trial PT session', 'Locker'], cta_label: 'Join', cta_url: '#contact', featured: 0 },
          { name: '3-month', price: '₹4,999', features: ['Gym access', 'Group classes', '3 PT sessions', 'Nutrition plan'], cta_label: 'Join', cta_url: '#contact', featured: 1 },
          { name: '6-month', price: '₹8,999', features: ['Gym access', 'All classes', '6 PT sessions', 'Body composition test', 'Free gym bag'], cta_label: 'Join', cta_url: '#contact', featured: 0 }
        ]},
      { type: 'form', heading: 'Claim your 7-day free trial', subheading: 'No credit card. No commitment. Just walk in.', form_slug: '' },
      { type: 'footer', text: '© ' + new Date().getFullYear() + ' Your Gym · Sweat together.' }
    ]
  },
  {
    id: 'generic',
    name: 'Generic — Lead Magnet',
    industry: 'Generic',
    description: 'Clean simple page suitable for any business — hero, 3 features, embedded form, contact.',
    theme_color: '#4f46e5',
    sections: [
      { type: 'hero', heading: 'Headline that sells your offer.', subheading: 'One-line description of what you do and who it\'s for.', cta_label: 'Get started', cta_url: '#contact' },
      { type: 'features', heading: 'What you get',
        items: [
          { icon: '⚡', title: 'Benefit one', body: 'Describe the first key benefit.' },
          { icon: '🎯', title: 'Benefit two', body: 'Describe the second key benefit.' },
          { icon: '🏆', title: 'Benefit three', body: 'Describe the third key benefit.' }
        ]},
      { type: 'form', heading: 'Get in touch', form_slug: '' },
      { type: 'contact', heading: 'Or reach us directly', email: 'hello@yourcompany.com', phone: '+91 ...' },
      { type: 'footer', text: '© ' + new Date().getFullYear() + ' Your Company' }
    ]
  }
];

module.exports = { TEMPLATES };
