import type { EditorProblem } from './editor-state';

// The validator returns a flat list; the form needs them by field.
export function indexProblems(problems: EditorProblem[]) {
  const form: string[] = [];
  const name: string[] = [];
  const performedAt: string[] = [];
  const exercises = new Map<string, string[]>();
  const sets = new Map<string, string[]>();

  for (const problem of problems) {
    switch (problem.at) {
      case 'form':
        form.push(problem.message);
        break;
      case 'name':
        name.push(problem.message);
        break;
      case 'performedAt':
        performedAt.push(problem.message);
        break;
      case 'exercise':
        exercises.set(problem.exerciseId, [
          ...(exercises.get(problem.exerciseId) ?? []),
          problem.message,
        ]);
        break;
      case 'set':
        sets.set(problem.setId, [...(sets.get(problem.setId) ?? []), problem.message]);
        break;
    }
  }

  return { form, name, performedAt, exercises, sets };
}
