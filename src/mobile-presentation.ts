import type { PullPlan, Resolution } from './mobile/types.ts';

export function pullSummary(plan: PullPlan): string {
  const changed = plan.changes.filter(change => change.kind === 'remote' || change.kind === 'conflict').length;
  const metadata=plan.summary.metadataFiles?`另有 ${plan.summary.metadataFiles} 个 Git 元数据文件随本机 Git 保持。`:'';
  return `GitHub：${plan.summary.remoteFiles} 个文件、${plan.summary.remoteDirectories} 个目录。同步范围：${plan.summary.managedFiles} 个文档或附件，主动排除 ${plan.summary.excluded.length} 个文件。${metadata}本次待检查 ${changed} 个文件变化，补齐 ${plan.directories.length} 个目录。当前仅完成检查，尚未应用到本机。`;
}

export function appliedSummary(plan: PullPlan, resolutions: Record<string, Resolution>, preserved: string[] = []): string {
  const applied = plan.changes.filter(change => (change.kind === 'remote' || change.kind === 'conflict') && resolutions[change.path] !== 'local' && !preserved.includes(change.path));
  return `已完成：下载或更新 ${applied.filter(change => !change.deleted).length} 个文件，确认删除 ${applied.filter(change => change.deleted).length} 个文件。已核对目录结构（预览待补齐目录 ${plan.directories.length} 个）。保留后续本地编辑 ${preserved.length} 个，请检查。排除项 ${plan.summary.excluded.length} 个可在下次检查中查看。`;
}
