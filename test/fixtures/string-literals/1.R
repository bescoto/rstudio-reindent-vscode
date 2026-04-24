Func <- function() {
  "a
b" # strings shouldn't be autoindented
  after_literal # normal indentation relative to scope
}

Func <- function() {
  'a
b' # strings shouldn't be autoindented
  after_literal # normal indentation relative to scope
}

Func <- function() {
  ("a
b")
  after_literal
}

