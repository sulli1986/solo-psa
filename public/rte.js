(() => {
  const form = document.querySelector('[data-rte]');
  if (!form) return;

  const mount = form.querySelector('[data-rte-mount]');
  const input = form.querySelector('[data-rte-input]');
  const fileInput = form.querySelector('[data-rte-files]');
  const fileList = form.querySelector('[data-rte-file-list]');

  if (!mount || !input) return;

  let quill = null;
  if (typeof Quill !== 'undefined') {
    quill = new Quill(mount, {
      theme: 'snow',
      placeholder: mount.dataset.placeholder || 'Write your reply…',
      modules: {
        toolbar: [
          [{ header: [1, 2, 3, false] }],
          ['bold', 'italic', 'underline', 'strike'],
          [{ color: [] }, { background: [] }],
          [{ list: 'ordered' }, { list: 'bullet' }],
          [{ indent: '-1' }, { indent: '+1' }],
          ['blockquote', 'link', 'code-block'],
          ['clean']
        ]
      }
    });
  } else {
    mount.setAttribute('contenteditable', 'true');
    mount.classList.add('rte-fallback');
  }

  function editorHtml() {
    return quill ? quill.root.innerHTML.trim() : mount.innerHTML.trim();
  }

  function editorEmpty() {
    if (quill) return !quill.getText().trim();
    return !mount.textContent.trim();
  }

  if (fileInput && fileList) {
    fileInput.addEventListener('change', () => {
      fileList.innerHTML = '';
      for (const file of fileInput.files) {
        const li = document.createElement('li');
        li.textContent = `${file.name} (${Math.round(file.size / 1024)} KB)`;
        fileList.appendChild(li);
      }
    });
  }

  form.addEventListener('submit', (e) => {
    if (editorEmpty()) {
      e.preventDefault();
      (quill || mount).focus?.();
      return;
    }
    input.value = editorHtml();
  });
})();
