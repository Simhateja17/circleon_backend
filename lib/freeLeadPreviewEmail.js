const nodemailer = require('nodemailer');

const BRAND = {
  ink: '#1A172C',
  muted: '#716F82',
  softMuted: '#9E9CAD',
  purple: '#471E86',
  purpleSoft: '#F1EEFD',
  gold: '#C49E62',
  line: '#E7E2EF',
  white: '#FFFFFF',
};

function clean(value) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeUrl(value) {
  const url = clean(value);
  if (!url) return '';
  const candidate = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  try {
    const parsed = new URL(candidate);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString() : '';
  } catch (_) {
    return '';
  }
}

function displayNumber(value) {
  if (value === null || value === undefined || value === '') return '';
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString('en-US') : clean(value);
}

function displayMoney(value) {
  if (value === null || value === undefined || value === '') return '';
  const number = Number(value);
  if (!Number.isFinite(number)) return clean(value);
  return `$${number.toLocaleString('en-US')}`;
}

function firstValue(...values) {
  return values.map(clean).find(Boolean) || '';
}

function companyLocation(company, companyData, fallback) {
  return firstValue(
    company.location,
    [companyData.city, companyData.state, companyData.country].filter(Boolean).join(', '),
    fallback,
  );
}

function personLocation(person, fallback) {
  return firstValue(person.location, fallback);
}

function leadView(lead = {}) {
  const profile = lead.personalization_profile || {};
  const person = profile.person || {};
  const company = profile.company || {};
  const companyData = lead.company_data || {};
  const experience = Array.isArray(person.relevant_experience)
    ? person.relevant_experience.filter(item => item && (item.organization || item.title)).slice(0, 5)
    : [];
  const evidence = (Array.isArray(profile.evidence) ? profile.evidence : (Array.isArray(profile.email_context) ? profile.email_context : []))
    .filter(item => item && (item.claim || item.fact || item.excerpt))
    .slice(0, 5);
  const technologies = (Array.isArray(company.technologies) ? company.technologies : (Array.isArray(companyData.technologies) ? companyData.technologies : []))
    .map(clean)
    .filter(Boolean)
    .slice(0, 8);
  const domain = firstValue(company.domain, companyData.domain, lead.company_domain);
  const website = safeUrl(firstValue(company.website_url, companyData.website_url, domain));
  const linkedin = safeUrl(firstValue(person.linkedin_url, lead.linkedin_url, company.linkedin_url, companyData.linkedin_url));

  return {
    name: firstValue(lead.full_name, `${person.first_name} ${person.last_name}`),
    initials: firstValue(
      [lead.first_name || person.first_name, lead.last_name || person.last_name]
        .filter(Boolean)
        .map(value => clean(value).charAt(0))
        .join(''),
      lead.full_name?.split(/\s+/).filter(Boolean).map(value => value.charAt(0)).join('').slice(0, 2),
      '?',
    ).toUpperCase(),
    title: firstValue(lead.title, person.title, person.headline),
    companyName: firstValue(lead.company_name, company.name, companyData.name),
    email: clean(lead.email),
    location: personLocation(person, lead.location),
    department: firstValue((person.departments || []).join(', '), person.seniority),
    linkedin,
    website,
    domain,
    experience,
    companyLocation: companyLocation(company, companyData, lead.location),
    industry: firstValue(company.industry, companyData.industry),
    employees: displayNumber(firstValue(company.employee_count, companyData.estimated_num_employees)),
    founded: firstValue(company.founded_year, companyData.founded_year),
    fundingStage: firstValue(company.funding_stage, companyData.latest_funding_stage),
    fundingDate: firstValue(company.funding_date, companyData.latest_funding_round_date),
    fundingTotal: displayMoney(firstValue(companyData.total_funding)),
    revenue: displayMoney(firstValue(companyData.annual_revenue)),
    description: firstValue(company.description, companyData.short_description),
    technologies,
    evidence,
  };
}

function textValue(label, value) {
  return value ? `${label}: ${value}` : '';
}

function buildTextLead(view, index) {
  const lines = [
    `${index + 1}. ${view.name || 'Unnamed prospect'}`,
    [view.title, view.companyName].filter(Boolean).join(' · '),
    textValue('Verified work email', view.email),
    textValue('Location', view.location),
    textValue('Department', view.department),
    '',
    'Contact intelligence',
    textValue('Role', view.title),
    textValue('Email', view.email),
    textValue('LinkedIn', view.linkedin),
    textValue('Relevant experience', view.experience.map(item => [item.title, item.organization, item.current ? 'current' : ''].filter(Boolean).join(' · ')).join('; ')),
    '',
    'Company intelligence',
    textValue('Industry', view.industry),
    textValue('Location', view.companyLocation),
    textValue('Employees', view.employees),
    textValue('Founded', view.founded),
    textValue('Latest funding', [view.fundingStage, view.fundingDate].filter(Boolean).join(' · ')),
    textValue('Total funding', view.fundingTotal),
    textValue('Revenue', view.revenue),
    textValue('Domain', view.domain),
    textValue('About', view.description),
    textValue('Technology signals', view.technologies.join(', ')),
    '',
    'Research signals',
    ...view.evidence.map(item => `- ${item.claim || item.fact || item.excerpt}${item.source_url ? ` (${item.source_url})` : ''}`),
  ];
  return lines.filter((line, lineIndex) => line || lines[lineIndex - 1] !== '').join('\n');
}

function htmlLink(label, url) {
  if (!url) return '';
  return `<a href="${escapeHtml(url)}" style="color:${BRAND.purple};text-decoration:none;font-weight:600;">${escapeHtml(label)}</a>`;
}

function field(label, value, options = {}) {
  if (!value) return '';
  const content = options.link ? htmlLink(value, options.link) : escapeHtml(value);
  return `<td width="50%" valign="top" style="padding:0 18px 22px 0;"><div style="font-family:Arial,sans-serif;font-size:11px;line-height:16px;letter-spacing:.14em;text-transform:uppercase;color:${BRAND.muted};">${escapeHtml(label)}</div><div style="font-family:Arial,sans-serif;font-size:15px;line-height:23px;color:${BRAND.ink};">${content}</div></td>`;
}

function fieldRow(left, right) {
  if (!left && !right) return '';
  return `<tr>${left || '<td width="50%" style="padding:0 18px 22px 0;"></td>'}${right || '<td width="50%" style="padding:0 18px 22px 0;"></td>'}</tr>`;
}

function experienceHtml(experience) {
  if (!experience.length) return '';
  return `<div style="font-family:Arial,sans-serif;font-size:11px;line-height:16px;letter-spacing:.14em;text-transform:uppercase;color:${BRAND.muted};margin:0 0 10px;">Relevant experience</div><div style="font-family:Arial,sans-serif;font-size:14px;line-height:25px;color:${BRAND.softMuted};">${experience.map(item => `<div>${escapeHtml([item.title, item.organization, item.current ? 'current' : ''].filter(Boolean).join(' · '))}</div>`).join('')}</div>`;
}

function evidenceHtml(evidence) {
  if (!evidence.length) return '';
  return `<div style="font-family:Arial,sans-serif;font-size:11px;line-height:16px;letter-spacing:.14em;text-transform:uppercase;color:${BRAND.muted};margin:0 0 10px;">Research signals</div>${evidence.map(item => {
    const text = item.claim || item.fact || item.excerpt;
    const source = safeUrl(item.source_url);
    return `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:23px;color:${BRAND.softMuted};padding:0 0 8px;">• ${source ? htmlLink(text, source) : escapeHtml(text)}</div>`;
  }).join('')}`;
}

function technologyHtml(technologies) {
  if (!technologies.length) return '';
  return `<div style="font-family:Arial,sans-serif;font-size:11px;line-height:16px;letter-spacing:.14em;text-transform:uppercase;color:${BRAND.muted};margin:0 0 10px;">Technology signals</div><div style="font-family:Arial,sans-serif;font-size:14px;line-height:23px;color:${BRAND.softMuted};">${technologies.map(technology => `<span style="display:inline-block;background:${BRAND.purpleSoft};color:${BRAND.purple};border-radius:999px;padding:4px 9px;margin:0 6px 6px 0;">${escapeHtml(technology)}</span>`).join('')}</div>`;
}

function buildHtmlLead(view, index) {
  const companyLinks = [
    view.linkedin ? htmlLink('LinkedIn', view.linkedin) : '',
    view.website ? htmlLink('Website', view.website) : '',
  ].filter(Boolean).join(' &nbsp;·&nbsp; ');
  const contactLinks = [
    view.linkedin ? htmlLink('LinkedIn profile', view.linkedin) : '',
    view.website ? htmlLink(view.domain || 'Company website', view.website) : '',
  ].filter(Boolean).join(' &nbsp;·&nbsp; ');
  const about = view.description
    ? `<p style="font-family:Arial,sans-serif;font-size:15px;line-height:26px;color:${BRAND.softMuted};margin:0;">${escapeHtml(view.description)}</p>`
    : '';

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:0 0 34px;">
    <tr><td style="padding:0 0 26px;border-bottom:1px solid ${BRAND.line};">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td width="76" valign="top"><div style="width:58px;height:58px;border-radius:50%;background:linear-gradient(145deg,${BRAND.purpleSoft},#F8F1E5);border:1px solid #DDD3ED;text-align:center;font-family:Arial,sans-serif;font-size:24px;line-height:58px;color:${BRAND.purple};">${escapeHtml(view.initials)}</div></td>
        <td valign="top"><div style="font-family:Georgia,serif;font-size:32px;line-height:38px;color:${BRAND.ink};">${escapeHtml(view.name || 'Unnamed prospect')}</div><div style="font-family:Arial,sans-serif;font-size:16px;line-height:26px;color:${BRAND.muted};">${escapeHtml([view.title, view.companyName].filter(Boolean).join(' · '))}</div><div style="margin-top:12px;"><span style="display:inline-block;background:${BRAND.purpleSoft};color:${BRAND.purple};border-radius:999px;padding:8px 13px;font-family:Arial,sans-serif;font-size:12px;font-weight:700;">Verified Work Email</span>${view.department ? `<span style="font-family:Arial,sans-serif;font-size:14px;color:${BRAND.muted};padding-left:12px;">${escapeHtml(view.department)}</span>` : ''}</div></td>
      </tr></table>
    </td></tr>
    <tr><td style="padding:28px 0 0;">
      <div style="font-family:Georgia,serif;font-size:25px;line-height:32px;color:${BRAND.ink};margin:0 0 20px;">Contact intelligence</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">${fieldRow(field('Role', view.title), field('Location', view.location))}${fieldRow(field('Department', view.department), field('Email', view.email))}${fieldRow(field('LinkedIn', view.linkedin ? 'View profile' : '', { link: view.linkedin }), field('Company', view.companyName))}</table>
      ${experienceHtml(view.experience)}
      ${contactLinks ? `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:23px;margin-top:18px;">${contactLinks}</div>` : ''}
    </td></tr>
    <tr><td style="padding:28px 0 0;border-top:1px solid ${BRAND.line};">
      <div style="font-family:Georgia,serif;font-size:25px;line-height:32px;color:${BRAND.ink};margin:0 0 20px;">Company intelligence</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">${fieldRow(field('Employees', view.employees), field('Founded', view.founded))}${fieldRow(field('Industry', view.industry), field('Location', view.companyLocation))}${fieldRow(field('Latest funding', [view.fundingStage, view.fundingDate].filter(Boolean).join(' · ')), field('Total funding', view.fundingTotal))}${fieldRow(field('Domain', view.domain, { link: view.website }), field('Revenue', view.revenue))}</table>
      ${about}
      ${companyLinks ? `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:23px;margin-top:18px;">${companyLinks}</div>` : ''}
      ${(view.technologies.length || view.evidence.length) ? `<div style="margin-top:28px;">${technologyHtml(view.technologies)}${evidenceHtml(view.evidence)}</div>` : ''}
    </td></tr>
  </table>`;
}

function buildFreeLeadPreviewEmail({ request, leads = [], frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000' } = {}) {
  const companyName = clean(request?.company_name) || 'your business';
  const recipient = clean(request?.email);
  const views = leads.map(leadView);
  const count = views.length;
  const subject = count
    ? `Your CircleOn lead preview · ${count} matched lead${count === 1 ? '' : 's'}`
    : 'Your CircleOn lead preview is ready';
  const claimUrl = safeUrl(`${String(frontendUrl).replace(/\/$/, '')}/signup?source=free-leads`);
  const intro = count === 3
    ? `We found three prospects that match the audience you described for ${companyName}. Their contact and company information is below.`
    : count > 0
      ? `We found ${count} prospect${count === 1 ? '' : 's'} that match the audience you described for ${companyName}. We are sharing the strongest available matches below rather than filling the report with weak contacts.`
      : `We could not find a verified work-email match for ${companyName} in this preview. You can try a broader audience or use CircleOn AI to keep searching.`;
  const textLeads = views.length ? views.map(buildTextLead).join('\n\n----------------------------------------\n\n') : 'No verified work-email leads were available for this preview.';
  const htmlLeads = views.length ? views.map(buildHtmlLead).join('') : `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:26px;color:${BRAND.softMuted};padding:24px 0 34px;">No verified work-email leads were available for this preview. Try broadening the audience description and request another sample.</div>`;
  const text = [
    'CircleOn',
    'Your lead preview',
    '',
    intro,
    '',
    textLeads,
    '',
    'Get unlimited leads',
    claimUrl,
    '',
    'You requested this preview from CircleOn. This report contains research available at the time it was prepared. No outreach has been sent to these prospects.',
  ].join('\n');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head><body style="margin:0;background:#FAF9FF;padding:24px 12px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center"><table role="presentation" width="680" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:680px;background:${BRAND.white};border:1px solid ${BRAND.line};"><tr><td style="padding:34px 34px 28px;background:linear-gradient(135deg,${BRAND.ink},${BRAND.purple});"><div style="font-family:Arial,sans-serif;font-size:15px;font-weight:700;letter-spacing:.12em;color:${BRAND.white};">CIRCLEON</div><div style="font-family:Georgia,serif;font-size:34px;line-height:42px;color:${BRAND.white};margin-top:26px;">Your lead preview</div><div style="font-family:Arial,sans-serif;font-size:15px;line-height:24px;color:#D8D0E3;margin-top:10px;">A researched shortlist for ${escapeHtml(companyName)}</div></td></tr><tr><td style="padding:32px 34px 0;"><p style="font-family:Arial,sans-serif;font-size:16px;line-height:27px;color:${BRAND.muted};margin:0 0 30px;">${escapeHtml(intro)}</p>${htmlLeads}<div style="border-top:1px solid ${BRAND.line};padding:28px 0 8px;text-align:center;"><div style="font-family:Georgia,serif;font-size:25px;line-height:32px;color:${BRAND.ink};">Ready to keep going?</div><p style="font-family:Arial,sans-serif;font-size:14px;line-height:23px;color:${BRAND.softMuted};margin:8px 0 20px;">Save your leads and find more prospects matched to your audience.</p>${claimUrl ? `<a href="${escapeHtml(claimUrl)}" style="display:inline-block;background:${BRAND.gold};color:${BRAND.purple};font-family:Arial,sans-serif;font-size:15px;font-weight:700;text-decoration:none;padding:14px 24px;border-radius:8px;">Get unlimited leads&nbsp; →</a>` : ''}</div></td></tr><tr><td style="padding:24px 34px 32px;background:#FAF9FF;border-top:1px solid ${BRAND.line};"><p style="font-family:Arial,sans-serif;font-size:12px;line-height:20px;color:${BRAND.softMuted};margin:0;">You requested this preview from CircleOn. This report contains research available at the time it was prepared. No outreach has been sent to these prospects.</p></td></tr></table></td></tr></table></body></html>`;

  return { subject, text, html, recipient };
}

function createPreviewTransport() {
  const host = clean(process.env.FREE_LEAD_PREVIEW_SMTP_HOST);
  const user = clean(process.env.FREE_LEAD_PREVIEW_SMTP_USER);
  const pass = process.env.FREE_LEAD_PREVIEW_SMTP_PASS;
  const fromEmail = clean(process.env.FREE_LEAD_PREVIEW_FROM_EMAIL || user);
  if (!host || !user || !pass || !fromEmail) {
    throw new Error('FREE_LEAD_PREVIEW_SMTP_HOST, FREE_LEAD_PREVIEW_SMTP_USER, FREE_LEAD_PREVIEW_SMTP_PASS, and FREE_LEAD_PREVIEW_FROM_EMAIL are required');
  }
  const port = Number(process.env.FREE_LEAD_PREVIEW_SMTP_PORT || 587);
  return {
    transport: nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
    }),
    from: `${clean(process.env.FREE_LEAD_PREVIEW_FROM_NAME) || 'CircleOn'} <${fromEmail}>`,
    replyTo: clean(process.env.FREE_LEAD_PREVIEW_REPLY_TO) || undefined,
  };
}

async function sendFreeLeadPreviewEmail({ request, leads = [] } = {}) {
  const message = buildFreeLeadPreviewEmail({ request, leads });
  const { transport, from, replyTo } = createPreviewTransport();
  const result = await transport.sendMail({
    from,
    to: message.recipient,
    replyTo,
    subject: message.subject,
    text: message.text,
    html: message.html,
  });
  return { messageId: result.messageId, response: result.response, subject: message.subject };
}

module.exports = {
  buildFreeLeadPreviewEmail,
  createPreviewTransport,
  leadView,
  sendFreeLeadPreviewEmail,
};
