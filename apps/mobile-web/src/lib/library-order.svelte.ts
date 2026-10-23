// The order of the libraries (Bibliothèques tab, Settings > Appearance): the user's own, by hand, kept on the phone
// per account. A library the order does not know yet comes after, in the server's order. The account's server-side
// order (OrderedViews, set in the server's web app) is left as it is: it is that order the phone starts from.
import type { BaseItem } from '$shared/models';
import type { Api } from '$tv/api';
import { load, save } from '$tv/storage';

const orders = $state<Record<string, string[]>>(load<Record<string, string[]>>('libraryOrder', {}));
const key = (api: Api) => `${api.serverId ?? api.address}/${api.userId}`;

export function arranged(api: Api, views: BaseItem[]): BaseItem[] {
  const order = orders[key(api)];
  if (!order?.length) return views;
  const at = (v: BaseItem) => {
    const i = order.indexOf(v.Id);
    return i < 0 ? order.length + views.indexOf(v) : i;
  };
  return [...views].sort((a, b) => at(a) - at(b));
}

export function setOrder(api: Api, ids: string[]): void {
  orders[key(api)] = ids;
  save('libraryOrder', $state.snapshot(orders));
}

export function moved<T>(list: T[], from: number, to: number): T[] {
  const out = [...list];
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x);
  return out;
}
