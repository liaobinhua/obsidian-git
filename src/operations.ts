/** Serialize local inspection with explicit actions without swallowing their errors. */
export class Operations {
  private tail:Promise<unknown>=Promise.resolve();
  call<T>(action:()=>Promise<T>):Promise<T>{const next=this.tail.then(action);this.tail=next.catch(()=>undefined);return next;}
}
