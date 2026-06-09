export type PlanReviewMode = 'chatReview' | 'permissionPreview';

export interface PlanReviewState {
  mode: PlanReviewMode | 'none';
  visible: false;
  status: 'idle' | 'drafting' | 'awaitingApproval' | 'approved' | 'rejected';
  planId?: string;
  title?: string;
  markdown?: string;
}

export function createHiddenPlanReviewState(): PlanReviewState {
  return {
    mode: 'none',
    visible: false,
    status: 'idle',
  };
}
