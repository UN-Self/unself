// SPDX-License-Identifier: GPL-3.0-only

/**
 * DM 拉黑拦截的统一口径（#347）：普通发送（message-submission）与转发（forward-submission）
 * 共用同一文案与错误码，避免两处硬编码漂移。
 */
export const DM_BLOCK_REJECTIONS = {
	blockedByPeer: { message: "发送被拒，你已经被拉黑", code: "blocked_by_recipient", status: 403 },
	blockedBySender: { message: "请先解除拉黑再发送", code: "recipient_blocked", status: 403 },
};

/** blockStatus → 命中的拒绝描述；可发送时返回 null。 */
export function dmBlockRejectionOf(blockStatus) {
	if (blockStatus?.blockedByPeer) return DM_BLOCK_REJECTIONS.blockedByPeer;
	if (blockStatus?.blockedBySender) return DM_BLOCK_REJECTIONS.blockedBySender;
	return null;
}
