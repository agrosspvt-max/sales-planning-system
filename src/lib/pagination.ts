export interface PageParams {
  page: number;
  pageSize: number;
  search: string;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;

export function parsePageParams(searchParams: URLSearchParams): PageParams {
  const page = Math.max(1, Number(searchParams.get("page") ?? 1) || 1);
  const rawSize = Number(searchParams.get("pageSize") ?? DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, rawSize));
  const search = (searchParams.get("search") ?? "").trim();
  return { page, pageSize, search };
}

export function buildPage<T>(items: T[], total: number, params: PageParams): Paginated<T> {
  return {
    items,
    total,
    page: params.page,
    pageSize: params.pageSize,
    totalPages: Math.max(1, Math.ceil(total / params.pageSize)),
  };
}
