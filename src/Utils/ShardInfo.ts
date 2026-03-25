import { IShardInfoConstructorParams, IShardInfoUpdateFields } from "../Types/index";

export default class ShardInfo {
  public id: string | number;
  public index: number;
  public total: number;
  public phoneNumber: string | null;
  public status: string;
  public updatedAt: Date;

  constructor({ 
    id, 
    index, 
    total, 
    phoneNumber = null, 
    status = "initializing" 
  }: IShardInfoConstructorParams) {
    this.id = id;
    this.index = index;
    this.total = total;
    this.phoneNumber = phoneNumber;
    this.status = status;
    this.updatedAt = new Date();
  }

  update(fields: IShardInfoUpdateFields = {}): void {
    Object.assign(this, fields);
    this.updatedAt = new Date();
  }
}
