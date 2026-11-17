// These partial checks leave the report's meaning and useful handoffs to the prose directives.
export const pairTextWarnings = (text: string, hasFiles = false): readonly { readonly token: string; readonly id: string; readonly problem: string }[] => {
  const warnings = [];
  if (/^[ \t]*\[REPORT\]/.test(text)) warnings.push({ token: "PAIR_REPORT_SHAPE", id: "report-shape", problem: "first line starts with [REPORT]" });
  // Ignore punctuation around acknowledgements, but never strip extra words or evidence; files make a message more than an acknowledgement.
  if (!hasFiles && /^(?:(?:받았어|확인했어|알겠어|알았어|확인했습니다|확인|넵|네|예|응|ㅇㅋ|오케이|okay|ok|got it|noted|ack)[\s,.!~…。！?？]*)+$/i.test(text.trim()))
    warnings.push({ token: "PAIR_ACK_ONLY", id: "pair-efficient", problem: "message contains only acknowledgements" });
  return warnings;
};
