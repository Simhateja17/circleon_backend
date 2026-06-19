function buildDisclosurePrompt(agentConfig, workspace, basePrompt = '') {
  const companyName = agentConfig?.company_name || workspace?.name || 'the company I represent';
  const agentName = agentConfig?.agent_name || 'Barsha';
  const promptBody = String(basePrompt || '').trim();

  return `# DISCLOSURE REQUIREMENT
You must open every outbound cold call by saying you are an AI assistant calling on behalf of ${companyName}. Do not wait for the prospect to ask.

Example opening:
"Hi, this is ${agentName}, an AI assistant calling on behalf of ${companyName}. I will keep this brief. Is now a good time for a quick two-minute conversation?"

# COMPLIANCE
- If the prospect asks not to be called again, acknowledge it, end the call, and mark the outcome as do_not_call.
- Do not pressure, mislead, or imply a human is speaking.
- If recording is enabled, mention that the call may be recorded for quality and training.

${promptBody}`.trim();
}

module.exports = {
  buildDisclosurePrompt,
};
