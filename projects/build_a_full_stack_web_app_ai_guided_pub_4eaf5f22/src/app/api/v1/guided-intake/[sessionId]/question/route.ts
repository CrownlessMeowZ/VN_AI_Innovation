import { handleRoute, AppError, jsonOk } from '@/lib/errors';
import { enforceRateLimit } from '@/lib/rate-limit';
import { readJsonBody, requireString } from '@/lib/http';
import { requireSessionToken } from '@/lib/auth';
import { getProvider } from '@/lib/data-provider';
import { computeQuestionFlow, pruneAnswers } from '@/lib/intake-machine';
import { getLlmProvider, mockLlm, type ProcedureQuestionInput } from '@/lib/ai/llm';
import { prisma } from '@/lib/db';

export const POST = handleRoute(async (
  req: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) => {
  enforceRateLimit('intake-side-question', req);
  const { sessionId } = await params;
  const body = await readJsonBody(req);
  const message = requireString(body, 'message', 1000);

  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session || session.expiresAt.getTime() < Date.now()) {
    throw new AppError(404, 'SESSION_EXPIRED', 'Phiên làm việc đã hết hạn.');
  }
  requireSessionToken(req, session.accessTokenHash);

  const provider = getProvider();
  const procedure = await provider.getProcedure(session.procedureCode);
  const procedureRow = await prisma.procedure.findUnique({
    where: { code: session.procedureCode },
    select: { id: true },
  });
  if (!procedure || !procedureRow) {
    throw new AppError(404, 'PROCEDURE_NOT_FOUND', 'Không tìm thấy thủ tục.');
  }

  const [questions, documents, version] = await Promise.all([
    provider.getClarifyingQuestions(procedureRow.id),
    provider.getDocuments(procedureRow.id),
    provider.getActiveProcedureVersion(procedureRow.id),
  ]);
  const rawAnswers =
    session.answersJson && typeof session.answersJson === 'object' && !Array.isArray(session.answersJson)
      ? session.answersJson as Record<string, unknown>
      : {};
  const { answers } = pruneAnswers(questions, rawAnswers);
  const flow = computeQuestionFlow(questions, answers);
  if (!flow.next) {
    throw new AppError(409, 'INTAKE_COMPLETE', 'Phiên đã thu thập đủ thông tin.');
  }

  const input: ProcedureQuestionInput = {
    procedureCode: procedure.code,
    procedureName: procedure.name,
    agency: procedure.agency,
    durationText: version?.durationText ?? '',
    feesText: version?.feesText ?? '',
    legalBasisText: version?.legalBasisText,
    documents: documents.map((document) => ({
      name: document.name,
      submissionType: document.submissionType,
      originals: document.originals,
      copies: document.copies,
    })),
    currentQuestionText: flow.next.questionText,
    currentOptionLabels: (flow.next.options ?? []).map((option) => option.label),
    userQuestion: message,
  };

  const llm = getLlmProvider();
  let aiMode = llm.name;
  let degraded = false;
  let answer: string;
  try {
    answer = await llm.answerProcedureQuestion(input);
  } catch {
    answer = await mockLlm.answerProcedureQuestion(input);
    aiMode = 'mock';
    degraded = true;
  }

  return jsonOk({
    answer,
    currentQuestionCode: flow.next.code,
    currentQuestionText: flow.next.questionText,
    aiMode,
    degraded,
  });
});
