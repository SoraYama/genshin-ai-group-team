import type { RecommendationResult } from '../services/recommendation.js';

export interface RecommendationHistoryEntry {
  id: string;
  uid?: string;
  createdAt: string;
  enemyNames: string[];
  preference?: string;
  source: RecommendationResult['source'];
  summary: string;
  teams: RecommendationResult['teams'];
}

export interface RecommendationCompareResult {
  left: RecommendationResult;
  right: RecommendationResult;
  diffSummary: string;
}
