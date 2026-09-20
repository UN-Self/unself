// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 模块图标（#12，§6.5 图标规范）：
 * manifest icon 字段存 Lucide 图标名（^[a-z0-9-]+$，#1 契约），
 * 壳白名单映射到 lucide-vue-next 组件渲染；缺省/未知回退模块名首字。
 * 禁止 emoji。
 */
import {
  Inbox,
  MessageCircle,
  Calendar,
  KanbanSquare,
  FileText,
  Video,
  GitBranch,
  Mail,
  HardDrive,
  LayoutGrid,
  type LucideIcon,
} from 'lucide-vue-next'

/** 壳内置白名单：常用的第一方/三方模块图标名 → Lucide 组件。 */
const ICON_WHITELIST: Record<string, LucideIcon> = {
  inbox: Inbox,
  chat: MessageCircle,
  message: MessageCircle,
  calendar: Calendar,
  board: KanbanSquare,
  kanban: KanbanSquare,
  doc: FileText,
  document: FileText,
  file: FileText,
  meet: Video,
  meeting: Video,
  video: Video,
  git: GitBranch,
  mail: Mail,
  storage: HardDrive,
  grid: LayoutGrid,
}

/** 解析 manifest icon 名 → Lucide 组件；未知/缺省返回 null（渲染层回退首字）。 */
export function resolveModuleIcon(icon: string | null | undefined): LucideIcon | null {
  if (!icon) return null
  return ICON_WHITELIST[icon] ?? null
}

/** 回退字符：模块名（id）首字，转大写展示。 */
export function moduleInitial(moduleId: string): string {
  const first = moduleId.trim().charAt(0)
  return first ? first.toUpperCase() : '?'
}
