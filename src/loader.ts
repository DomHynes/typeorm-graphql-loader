import { BaseEntity, Connection, SelectQueryBuilder } from "typeorm";
import { GraphQLResolveInfo } from "graphql";
import { Base } from "./base";
import * as crypto from "crypto";
import {
  FieldNodeInfo,
  LoaderOptions,
  QueryMeta,
  QueryOptions,
  QueryPagination,
  QueueItem
} from "./types";
import { GraphqlQueryBuilder } from "./graphqlQueryBuilder";
import { FieldNode, SelectionNode } from "graphql";

/**
 * GraphQLDatabaseLoader is a caching loader that folds a batch of different database queries into a singular query.
 */
export class GraphQLDatabaseLoader extends Base {
  private _queue: QueueItem[] = [];
  private _cache: Map<string, Promise<any>> = new Map();
  private _immediate?: NodeJS.Immediate;

  /**
   * Constructs an instance.
   * @param {Connection} connection The database connection.
   * @param {LoaderOptions} options (optional) Loader options.
   */
  constructor(
    public connection: Connection,
    public options: LoaderOptions = {}
  ) {
    super(options);
  }

  public static getFieldNodeInfo(
    info: GraphQLResolveInfo,
    fieldName: string
  ): FieldNodeInfo {
    const childFieldNode = info.fieldNodes
      .map(node => (node.selectionSet ? node.selectionSet.selections : []))
      .flat()
      .find((selection: SelectionNode) =>
        selection.kind !== "InlineFragment"
          ? selection.name.value === fieldName
          : false
      ) as FieldNode;

    const fieldNodes = [childFieldNode];
    return { fieldNodes, fragments: info.fragments, fieldName };
  }

  /**
   * Helper to handle pagination.
   * Future version will support cursor based pagination. For now, use
   * basic offset and limit
   * @param query
   * @param pagination
   */
  private static handlePagination(
    query: SelectQueryBuilder<Function | string | {}>,
    pagination: QueryPagination
  ): SelectQueryBuilder<Function | string | {}> {
    let qb = query;
    qb = qb.offset(pagination.offset);
    qb = qb.limit(pagination.limit);
    return qb;
  }

  /**
   * Load an entity from the database.
   * @param {typeof BaseEntity|string} entity The entity type to load.
   * @param where Query conditions.
   * @param {GraphQLResolveInfo} info (optional) GraphQL resolver information. If not provided, all fields are returned.
   * @param options
   * @returns {Promise<T>}
   */
  public async loadOne<T>(
    entity: Function | string,
    where: Partial<T>,
    info: GraphQLResolveInfo | FieldNodeInfo,
    options?: QueryOptions
  ): Promise<T | undefined> {
    const { found, item, key, fields } = this.processQueryMeta(info, where);
    if (found && item) {
      return item;
    }

    // Create a promise.
    const promise = new Promise<T | undefined>((resolve, reject) => {
      // Push resolve/reject to the queue.
      this._queue.push({
        many: false,
        batchIdx: this._queue.length,
        key,
        where,
        fields,
        resolve,
        reject,
        entity,
        options
      });
    });
    // Set a new immediate.
    this._immediate = setImmediate(() => this.processAll());
    // Cache the promise.
    this._cache.set(key, promise);
    // Return the promise.
    return promise;
  }

  /**
   * Load multiple entities that meet the same criteria .
   * @param {Function|string} entity The entity type to load.
   * @param {Partial<T>} where The conditions to match.
   * @param {GraphQLResolveInfo} info (optional)  GraphQL resolver information. If not provided, all fields are returned.
   * @param options
   * @returns {Promise<T?[]>}
   */
  public async loadMany<T>(
    entity: Function | string,
    where: Partial<T>,
    info: GraphQLResolveInfo | FieldNodeInfo,
    options?: QueryOptions
  ): Promise<T[]> {
    const { found, item, key, fields } = this.processQueryMeta(info, where);

    if (found && item) {
      return item;
    }
    // Create a promise.
    const promise = new Promise<T[]>((resolve, reject) => {
      // Push resolve/reject to the queue.
      this._queue.push({
        many: true,
        batchIdx: this._queue.length,
        key,
        where,
        fields,
        resolve,
        reject,
        entity,
        options
      });
    });
    // Set a new immediate.
    this._immediate = setImmediate(() => this.processAll());
    // Cache the promise.
    this._cache.set(key, promise);
    // Return the promise.
    return promise;
  }

  /**
   * LoadManyPaginated returns back getManyWithCount
   * @param entity
   * @param where
   * @param info
   * @param pagination
   * @param options
   */
  public async loadManyPaginated<T>(
    entity: Function | string,
    where: Partial<T>,
    info: GraphQLResolveInfo | FieldNodeInfo,
    pagination: QueryPagination,
    options?: QueryOptions
  ): Promise<[T[], number]> {
    const { found, item, key, fields } = this.processQueryMeta(info, where);

    if (found && item) {
      return item;
    }
    const promise = new Promise<[T[], number]>((resolve, reject) => {
      this._queue.push({
        many: true,
        batchIdx: this._queue.length,
        key,
        where,
        fields,
        resolve,
        reject,
        entity,
        options,
        pagination
      });
    });
    // Set a new immediate.
    this._immediate = setImmediate(() => this.processAll());
    // Cache the promise.
    this._cache.set(key, promise);
    // Return the promise.
    return promise;
  }

  /**
   * Load multiple entities with different criteria.
   * @param {Function|string} entity The entity type to load.
   * @param {Partial<T>[]} where A series of conditions to match.
   * @param {GraphQLResolveInfo} info (optional)  GraphQL resolver information. If not provided, all fields are returned.
   * @param {QueryOptions} options
   * @returns {Promise<T?[]>}
   */
  public async batchLoadMany<T>(
    entity: Function | string,
    where: Partial<T>[],
    info: GraphQLResolveInfo | FieldNodeInfo,
    options?: QueryOptions
  ): Promise<(T | undefined)[]> {
    return await Promise.all(
      where.map(w => this.loadOne(entity, w, info, options))
    );
  }

  /**
   * Clears the loader cache.
   */
  public clear() {
    this._cache.clear();
  }

  /**
   * Process and clear the current queue.
   * @returns {Promise<void>}
   */
  protected async processAll(): Promise<any> {
    // Clear and capture the current queue.
    const queue = this._queue.splice(0, this._queue.length);
    try {
      // Create a new QueryBuilder instance.
      return await this.connection.transaction(async entityManager => {
        // const now = Date.now().toString(16);
        queue.map(async q => {
          const name = typeof q.entity == "string" ? q.entity : q.entity.name;
          const alias = name;
          let qb: SelectQueryBuilder<{}> = entityManager
            .getRepository<{}>(name)
            .createQueryBuilder(alias)
            .select([]);
          //.getRepository(q.entity).createQueryBuilder();
          // qb = qb.from(name, alias);
          const graphqlQueryBuilder = new GraphqlQueryBuilder(this.options);
          qb = graphqlQueryBuilder.createQuery(
            name,
            q.fields,
            entityManager.connection,
            qb as any,
            alias
          );
          qb = qb.where(q.where);
          // qb.orderBy(`"${alias}"."created_date"`, "ASC");
          const options = q.options;
          if (options) {
            qb = this.handleQueryOptions(qb, alias, options);
          }
          // pagination
          if (q.pagination) {
            qb = GraphQLDatabaseLoader.handlePagination(qb, q.pagination);
            // we use a different execution method, so we need to return
            // with different logic
            return qb
              .getManyAndCount()
              .then(q.resolve, q.reject)
              .finally(async () => {
                this._cache.delete(q.key);
              });
          }

          const promise = q.many ? qb.getMany() : qb.getOne();
          return promise.then(q.resolve, q.reject).finally(async () => {
            this._cache.delete(q.key);
          });
        });
      });
    } catch (e) {
      // An error occurred, reject the entire queue.
      queue.forEach(q => {
        q.reject(e);
        this._cache.delete(q.key);
      });
    }
  }

  /**
   * Processes the request into the cache
   * @param info
   * @param where
   */
  private processQueryMeta<T>(
    info: GraphQLResolveInfo | FieldNodeInfo,
    where: Partial<T>
  ): QueryMeta {
    // Create a md5 hash.
    const hash = crypto.createHash("md5");
    // Get the fields queried by GraphQL.
    if (!info) {
      throw new Error("Missing info parameter");
    }
    const fields = GraphqlQueryBuilder.graphqlFields(info);
    // Generate a key hash from the query parameters.
    const key = hash
      .update(JSON.stringify([where, fields]))
      .digest()
      .toString("hex");
    // If the key matches a cache entry, return it.
    if (this._cache.has(key)) {
      return {
        fields,
        key: "",
        item: this._cache.get(key)!,
        found: true
      };
    }
    // If we have an immediate scheduled, cancel it.
    if (this._immediate) {
      clearImmediate(this._immediate);
    }
    return {
      fields,
      key,
      found: false
    };
  }

  /**
   * Applies the query options to the query builder
   * @param query
   * @param alias
   * @param options
   */
  private handleQueryOptions<T>(
    query: SelectQueryBuilder<Function | string | {}>,
    alias: string,
    options: QueryOptions
  ): SelectQueryBuilder<Function | string | {}> {
    let qb = query;
    // Include any required select fields
    if (options.requiredSelectFields) {
      options.requiredSelectFields.forEach(field => {
        qb = qb.addSelect(
          this.formatColumnSelect(alias, field),
          this.formatAliasField(alias, field)
        );
      });
    }

    // Include any search parameters
    if (options.search) {
      const { query, params } = this.generateSearchString(
        alias,
        options.search
      );
      qb = qb.andWhere(query, params);
    }
    // append any or where conditions
    if (options.orWhere && options.orWhere.length) {
      options.orWhere.forEach(where => {
        qb = qb.orWhere(where);
      });
    }

    // check if we must order the query
    qb = options.order ? qb.orderBy(options.order) : qb;
    return qb;
  }
}
