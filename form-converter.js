// ═══════════════════════════════════════════════════════════════
//  FORM CONVERTER
//  Detects <form> elements and generates react-hook-form components
// ═══════════════════════════════════════════════════════════════

/**
 * Extract all form fields from a Cheerio form element.
 */
function extractFields($form, $) {
    const fields = [];
    $form.find('input, textarea, select').each((_, el) => {
        const $el = $(el);
        const type = $el.attr('type') || (el.tagName === 'textarea' ? 'textarea' : el.tagName === 'select' ? 'select' : 'text');
        if (type === 'submit' || type === 'button' || type === 'hidden' || type === 'reset') return;
        const name = $el.attr('name') || $el.attr('id') || `field_${fields.length}`;
        fields.push({
            name: name.replace(/[^a-zA-Z0-9_]/g, '_'),
            type,
            placeholder: $el.attr('placeholder') || '',
            required: $el.attr('required') !== undefined,
        });
    });
    return fields;
}

/**
 * Build field JSX for a single field.
 */
function buildFieldJsx(field) {
    const required = field.required ? `, { required: '${field.name} is required' }` : '';
    if (field.type === 'textarea') {
        return `      <textarea {...register('${field.name}'${required})} placeholder="${field.placeholder}" />
      {errors.${field.name} ? <span role="alert">{errors.${field.name}.message}</span> : null}`;
    }
    if (field.type === 'select') {
        return `      <select {...register('${field.name}'${required})}>
        <option value="">Select...</option>
      </select>
      {errors.${field.name} ? <span role="alert">{errors.${field.name}.message}</span> : null}`;
    }
    return `      <input {...register('${field.name}'${required})} type="${field.type}" placeholder="${field.placeholder}" />
      {errors.${field.name} ? <span role="alert">{errors.${field.name}.message}</span> : null}`;
}

function toComponentName(formId) {
    return (formId || 'form')
        .replace(/[^a-zA-Z0-9]/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/^./, c => c.toUpperCase())
        .replace(/_([a-z])/g, (_, c) => c.toUpperCase()) || 'ContactForm';
}

function buildSsrFormComponent(formId, fields) {
    const componentName = toComponentName(formId);
    const typeFields = fields.map(f => `  ${f.name}: string;`).join('\n');
    const fieldsJsx = fields.map(buildFieldJsx).join('\n');

    return `'use client';
import { useForm } from 'react-hook-form';
import { submitForm } from '@/app/actions';

type FormData = {
${typeFields}
};

export default function ${componentName}() {
  const { register, formState: { errors, isSubmitting } } = useForm<FormData>();

  return (
    <form action={submitForm}>
${fieldsJsx}
      <button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Sending...' : 'Send'}
      </button>
    </form>
  );
}
`;
}

function buildStaticFormComponent(formId, fields) {
    const componentName = toComponentName(formId);
    const typeFields = fields.map(f => `  ${f.name}: string;`).join('\n');
    const fieldsJsx = fields.map(buildFieldJsx).join('\n');

    return `'use client';
import { useForm } from 'react-hook-form';

type FormData = {
${typeFields}
};

export default function ${componentName}() {
  const { register, formState: { errors, isSubmitting } } = useForm<FormData>();

  return (
    // TODO: Replace YOUR_FORM_ID with your Formspree form ID from formspree.io
    <form action="https://formspree.io/f/YOUR_FORM_ID" method="POST">
${fieldsJsx}
      <button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Sending...' : 'Send'}
      </button>
    </form>
  );
}
`;
}

function buildServerAction() {
    return `'use server';

/**
 * Handle contact form submission.
 * TODO: Replace console.log with your email service.
 * Example with Resend (https://resend.com):
 *   import { Resend } from 'resend';
 *   const resend = new Resend(process.env.RESEND_API_KEY);
 *   await resend.emails.send({ from: 'noreply@yourdomain.com', to: 'you@email.com', subject: 'New form submission', text: JSON.stringify(data) });
 */
export async function submitForm(formData: FormData) {
  const data = Object.fromEntries(formData.entries());
  console.log('Form submitted:', data);
}
`;
}

/**
 * Convert all <form> elements in a Cheerio document.
 * @param {object} $ - Loaded cheerio document
 * @param {'ssr' | 'static'} exportMode
 * @returns {{ components: string[], serverAction: string | null, dependencies: string[] }}
 */
function convertForms($, exportMode) {
    const components = [];
    let serverAction = null;
    let hasForm = false;

    $('form').each((i, el) => {
        const $form = $(el);
        const formId = $form.attr('id') || $form.attr('name') || `form_${i}`;
        const fields = extractFields($form, $);
        if (fields.length === 0) return;

        hasForm = true;
        if (exportMode === 'ssr') {
            components.push(buildSsrFormComponent(formId, fields));
        } else {
            components.push(buildStaticFormComponent(formId, fields));
        }
    });

    if (hasForm && exportMode === 'ssr') {
        serverAction = buildServerAction();
    }

    return {
        components,
        serverAction,
        dependencies: hasForm ? ['react-hook-form'] : [],
    };
}

module.exports = { convertForms };
