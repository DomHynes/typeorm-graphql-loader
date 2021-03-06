export function toPlain(object: any) {
  return JSON.parse(JSON.stringify(object));
}

export function fakeGraphqlInfo() {
  return {
    fieldNodes: [
      {
        kind: "Field",
        alias: null,
        name: { kind: "Name", value: "me", loc: [Object] },
        arguments: [],
        directives: [],
        selectionSet: {
          kind: "SelectionSet",
          selections: [
            {
              kind: "Field",
              alias: null,
              name: [Object],
              arguments: [],
              directives: [],
              selectionSet: null,
              loc: [Object]
            },
            {
              kind: "Field",
              alias: null,
              name: [Object],
              arguments: [],
              directives: [],
              selectionSet: [Object],
              loc: [Object]
            }
          ]
        },
        loc: { start: 4, end: 46 }
      }
    ]
  };
}
