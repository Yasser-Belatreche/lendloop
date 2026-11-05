"use client";

import { useMutation } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { CATEGORIES, CONDITIONS, type Category, type Condition, useAction } from "./ui";

type Initial = { _id: Id<"tools">; name: string; category: Category; condition: Condition; description: string };

export function ToolForm({ initial, onDone }: { initial?: Initial; onDone?: () => void }) {
  const create = useMutation(api.tools.create);
  const update = useMutation(api.tools.update);
  const [name, setName] = useState(initial?.name ?? "");
  const [category, setCategory] = useState<Category>(initial?.category ?? "power tools");
  const [condition, setCondition] = useState<Condition>(initial?.condition ?? "good");
  const [description, setDescription] = useState(initial?.description ?? "");
  const save = useAction(async () => {
    const args = { name, category, condition, description };
    if (initial) await update({ toolId: initial._id, ...args });
    else await create(args);
  });

  return (
    <form
      className="form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (await save.run()) {
          if (!initial) {
            setName("");
            setDescription("");
          }
          onDone?.();
        }
      }}
    >
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required placeholder="Cordless drill" />
      </label>
      <div className="row">
        <label>
          Category
          <select value={category} onChange={(e) => setCategory(e.target.value as Category)}>
            {CATEGORIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label>
          Condition
          <select value={condition} onChange={(e) => setCondition(e.target.value as Condition)}>
            {CONDITIONS.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
      </div>
      <label>
        Short description
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} rows={3} placeholder="Two batteries, bring it back charged please" />
      </label>
      {save.error && <p className="error">{save.error}</p>}
      <button className="primary" disabled={save.pending}>
        {initial ? "Save changes" : "List tool"}
      </button>
    </form>
  );
}
